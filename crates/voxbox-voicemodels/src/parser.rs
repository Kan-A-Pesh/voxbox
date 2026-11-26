//! Pure extraction of voice-models.com listing rows and pagination state.
//!
//! `fetch_data.php` answers `{ "table": "<tr>…</tr>…", "pagination": "<ul>…</ul>" }`.

use std::collections::HashSet;

use scraper::{ElementRef, Html, Selector};
use serde::Deserialize;
use url::Url;

use crate::{ModelPage, RemoteModel, VoiceModelsError};

/// Both fields are required (an empty result still sends them): another shape, such as an
/// error object, is a parse error rather than an empty final page.
#[derive(Deserialize)]
struct FetchDataResponse {
    table: String,
    pagination: String,
}

/// Parses the JSON body returned by `fetch_data.php`.
pub fn parse_response(body: &str, base_url: &str) -> Result<ModelPage, VoiceModelsError> {
    let response: FetchDataResponse = serde_json::from_str(body)
        .map_err(|error| VoiceModelsError::Parse(format!("réponse JSON invalide ({error})")))?;
    Ok(parse_page(&response.table, &response.pagination, base_url))
}

/// Parses the rows of one page. Each row carries the title in `a[href^='/model/']`, the size in
/// `span.badge.bg-secondary` and the zip URL in the copy button's `data-clipboard-text`.
/// Rows without an https download URL (or without a title) are skipped.
pub fn parse_page(table_html: &str, pagination_html: &str, base_url: &str) -> ModelPage {
    let Ok(base_url) = Url::parse(base_url) else {
        return ModelPage {
            models: Vec::new(),
            has_more: false,
        };
    };
    // `<tr>` outside a `<table>` is dropped by the HTML parser.
    let document = Html::parse_fragment(&format!("<table><tbody>{table_html}</tbody></table>"));
    let row_selector = selector("tr");
    let title_selector = selector("a[href^='/model/']");
    let size_selector = selector("span.badge.bg-secondary");
    let url_selector = selector("[data-clipboard-text]");

    let mut models = Vec::new();
    let mut seen = HashSet::new();
    for row in document.select(&row_selector) {
        let Some(link) = row.select(&title_selector).next() else {
            continue;
        };
        let title = collapsed_text(link);
        if title.is_empty() {
            continue;
        }
        let Some(page_url) = link
            .value()
            .attr("href")
            .and_then(|href| base_url.join(href).ok())
        else {
            continue;
        };
        let Some(download_url) = row
            .select(&url_selector)
            .filter_map(|element| element.value().attr("data-clipboard-text"))
            .filter_map(|raw| Url::parse(raw.trim()).ok())
            .find(|url| url.scheme() == "https" && url.host_str().is_some())
        else {
            continue;
        };
        let download_url = download_url.to_string();
        if !seen.insert(download_url.clone()) {
            continue;
        }
        let size = row
            .select(&size_selector)
            .next()
            .map(collapsed_text)
            .unwrap_or_default();
        models.push(RemoteModel {
            title,
            size,
            download_url,
            page_url: page_url.to_string(),
        });
    }

    // The site's pagination decides, even when every row of this page was skipped.
    let has_more = has_next_page(pagination_html);
    ModelPage { models, has_more }
}

/// The pagination's `li.page-item.next` is `disabled` on the last page.
fn has_next_page(pagination_html: &str) -> bool {
    let document = Html::parse_fragment(pagination_html);
    let next_selector = selector("li.page-item.next");
    document.select(&next_selector).any(|item| {
        !item
            .value()
            .attr("class")
            .unwrap_or_default()
            .split_ascii_whitespace()
            .any(|class| class == "disabled")
    })
}

fn collapsed_text(element: ElementRef<'_>) -> String {
    element
        .text()
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn selector(css: &str) -> Selector {
    Selector::parse(css).expect("static selector")
}

#[cfg(test)]
mod tests {
    use super::{parse_page, parse_response};

    const BASE_URL: &str = "https://voice-models.com";

    fn assert_well_formed(page: &crate::ModelPage) {
        for model in &page.models {
            assert!(!model.title.is_empty());
            assert!(!model.title.contains('<'), "tags stripped: {}", model.title);
            assert!(model.download_url.starts_with("https://"));
            assert!(model
                .page_url
                .starts_with("https://voice-models.com/model/"));
            // Some old rows have no size badge: the size is then empty.
            assert!(
                model.size.is_empty() || model.size.ends_with("MB") || model.size.ends_with("GB"),
                "size: {}",
                model.size
            );
        }
    }

    #[test]
    fn parses_the_first_page_of_the_live_catalogue() {
        let page = parse_response(include_str!("../tests/fixtures/page_1.json"), BASE_URL).unwrap();
        assert_eq!(page.models.len(), 25);
        assert!(page.has_more);
        assert_well_formed(&page);
        let first = &page.models[0];
        assert_eq!(first.title, "Blank [RVC v2] [200 Epochs]");
        assert_eq!(first.size, "78.71 MB");
        assert_eq!(
            first.download_url,
            "https://huggingface.co/UltraNumberOne/Miscellaneous/resolve/main/blank.zip?download=true"
        );
        assert_eq!(first.page_url, "https://voice-models.com/model/af5");
    }

    #[test]
    fn parses_a_search_page() {
        let page = parse_response(
            include_str!("../tests/fixtures/search_mario.json"),
            BASE_URL,
        )
        .unwrap();
        assert!(!page.models.is_empty());
        assert!(page.has_more);
        assert_well_formed(&page);
        assert!(page
            .models
            .iter()
            .any(|m| m.title.to_lowercase().contains("mario")));
    }

    #[test]
    fn the_last_page_has_no_more() {
        let page =
            parse_response(include_str!("../tests/fixtures/last_page.json"), BASE_URL).unwrap();
        assert!(!page.models.is_empty());
        assert!(!page.has_more);
        assert_well_formed(&page);
    }

    #[test]
    fn no_results_is_an_empty_final_page() {
        let page =
            parse_response(include_str!("../tests/fixtures/no_results.json"), BASE_URL).unwrap();
        assert!(page.models.is_empty());
        assert!(!page.has_more);
    }

    #[test]
    fn invalid_json_is_a_parse_error() {
        assert!(matches!(
            parse_response("<html>maintenance</html>", BASE_URL),
            Err(crate::VoiceModelsError::Parse(_))
        ));
    }

    #[test]
    fn a_response_missing_its_fields_is_a_parse_error() {
        for body in [
            r#"{"error":"rate limited"}"#,
            r#"{"table":"<tr></tr>"}"#,
            r#"{"pagination":"<ul></ul>"}"#,
            r#"{"table":null,"pagination":""}"#,
        ] {
            assert!(
                matches!(
                    parse_response(body, BASE_URL),
                    Err(crate::VoiceModelsError::Parse(_))
                ),
                "{body}"
            );
        }
    }

    #[test]
    fn skips_rows_without_https_url_and_deduplicates() {
        let table = "\
            <tr><td><a href='/model/1'>One &amp; <b>Two</b></a><span class='badge bg-secondary'>1 MB</span>\
            <button data-clipboard-text='https://h.co/a.zip'></button></td></tr>\
            <tr><td><a href='/model/2'>Dup</a><button data-clipboard-text='https://h.co/a.zip'></button></td></tr>\
            <tr><td><a href='/model/3'>Plain</a><button data-clipboard-text='http://h.co/b.zip'></button></td></tr>\
            <tr><td><a href='/model/4'>No url</a></td></tr>";
        let page = parse_page(table, "<li class='page-item next'></li>", BASE_URL);
        assert_eq!(page.models.len(), 1);
        assert_eq!(page.models[0].title, "One & Two");
        assert_eq!(page.models[0].size, "1 MB");
        assert!(page.has_more);
        // A page whose rows were all skipped still leads to the next one.
        let skipped = parse_page(
            "<tr><td><a href='/model/9'>Drive</a></td></tr>",
            "<li class='page-item next'></li>",
            BASE_URL,
        );
        assert!(skipped.models.is_empty());
        assert!(skipped.has_more);
        assert!(!parse_page(table, "<li class='page-item next disabled'></li>", BASE_URL).has_more);
    }
}
