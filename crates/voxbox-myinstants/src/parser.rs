//! Pure extraction of MyInstants listing cards and pagination state.

use std::collections::HashSet;

use scraper::{Html, Selector};
use url::Url;

use crate::{RemoteSound, SearchPage};

/// Parses `.instant` cards: the `.small-button` `onclick` contains the MP3 URL,
/// and the sibling `.instant-link` provides the title and page URL.
pub fn parse_listing(html: &str, base_url: &str) -> SearchPage {
    let Ok(base_url) = Url::parse(base_url) else {
        return empty_page();
    };
    let document = Html::parse_document(html);
    let instant_selector = Selector::parse(".instant").expect("static selector");
    let button_selector = Selector::parse(".small-button[onclick]").expect("static selector");
    let link_selector = Selector::parse(".instant-link[href]").expect("static selector");
    let pagination_selector =
        Selector::parse("#results-pagination .pagination").expect("static selector");
    let anchor_selector = Selector::parse("a[href]").expect("static selector");

    let mut sounds = Vec::new();
    let mut seen_mp3_urls = HashSet::new();

    for instant in document.select(&instant_selector) {
        let Some(button) = instant.select(&button_selector).next() else {
            continue;
        };
        let Some(onclick) = button.value().attr("onclick") else {
            continue;
        };
        let Some(mp3_path) = play_url_argument(onclick) else {
            continue;
        };
        let Some(link) = instant.select(&link_selector).next() else {
            continue;
        };
        let Some(page_path) = link.value().attr("href") else {
            continue;
        };

        let title = link
            .text()
            .collect::<String>()
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        if title.is_empty() {
            continue;
        }

        let (Ok(mp3_url), Ok(page_url)) = (base_url.join(&mp3_path), base_url.join(page_path))
        else {
            continue;
        };
        if !is_http_url(&mp3_url) || !is_http_url(&page_url) {
            continue;
        }
        let mp3_url = mp3_url.to_string();
        if !seen_mp3_urls.insert(mp3_url.clone()) {
            continue;
        }

        sounds.push(RemoteSound {
            title,
            mp3_url,
            page_url: page_url.to_string(),
        });
    }

    let has_more = document.select(&pagination_selector).any(|pagination| {
        pagination.select(&anchor_selector).any(|anchor| {
            let href = anchor.value().attr("href").unwrap_or_default();
            let is_next = anchor
                .value()
                .attr("rel")
                .unwrap_or_default()
                .split_ascii_whitespace()
                .any(|relation| relation.eq_ignore_ascii_case("next"));
            is_next && !href.is_empty() && href != "#"
        })
    });

    SearchPage { sounds, has_more }
}

fn play_url_argument(onclick: &str) -> Option<String> {
    let after_open = onclick.trim().strip_prefix("play(")?.trim_start();
    let quote = after_open.chars().next()?;
    if quote != '\'' && quote != '"' {
        return None;
    }

    let mut value = String::new();
    let mut escaped = false;
    for character in after_open[quote.len_utf8()..].chars() {
        if escaped {
            value.push(match character {
                'n' => '\n',
                'r' => '\r',
                't' => '\t',
                other => other,
            });
            escaped = false;
        } else if character == '\\' {
            escaped = true;
        } else if character == quote {
            return (!value.is_empty()).then_some(value);
        } else {
            value.push(character);
        }
    }
    None
}

fn is_http_url(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https")
}

fn empty_page() -> SearchPage {
    SearchPage {
        sounds: Vec::new(),
        has_more: false,
    }
}

#[cfg(test)]
mod tests {
    use super::parse_listing;
    use url::Url;

    const BASE_URL: &str = "https://www.myinstants.com";

    #[test]
    fn parses_live_trending_and_french_fixtures() {
        for fixture in [
            include_str!("../tests/fixtures/trending.html"),
            include_str!("../tests/fixtures/trending_fr.html"),
        ] {
            assert_fixture_is_well_formed(fixture);
        }
    }

    #[test]
    fn parses_both_live_search_pages_and_pagination() {
        let first = parse_listing(
            include_str!("../tests/fixtures/search_bruh_page_1.html"),
            BASE_URL,
        );
        let second = parse_listing(
            include_str!("../tests/fixtures/search_bruh_page_2.html"),
            BASE_URL,
        );

        assert!(!first.sounds.is_empty());
        assert!(first.has_more);
        assert!(!second.sounds.is_empty());
        assert!(second.has_more);
        assert_fixture_sounds_are_well_formed(&first.sounds);
        assert_fixture_sounds_are_well_formed(&second.sounds);
    }

    #[test]
    fn malformed_or_empty_html_returns_an_empty_page() {
        let page = parse_listing("<html><body><div class='instant'><button", BASE_URL);
        assert!(page.sounds.is_empty());
        assert!(!page.has_more);
        assert!(parse_listing("", BASE_URL).sounds.is_empty());
    }

    #[test]
    fn decodes_entities_and_deduplicates_repeated_mp3_urls() {
        let html = r#"
            <div class="instant"><button class="small-button" onclick="play('/media/sounds/same.mp3', 'a')"></button><a class="instant-link" href="/en/instant/one/">Tom &amp; Jerry</a></div>
            <div class="instant"><button class="small-button" onclick="play('/media/sounds/same.mp3', 'b')"></button><a class="instant-link" href="/en/instant/two/">Duplicate</a></div>
        "#;
        let page = parse_listing(html, BASE_URL);
        assert_eq!(page.sounds.len(), 1);
        assert_eq!(page.sounds[0].title, "Tom & Jerry");
        assert_eq!(
            page.sounds[0].mp3_url,
            "https://www.myinstants.com/media/sounds/same.mp3"
        );
    }

    fn assert_fixture_is_well_formed(fixture: &str) {
        let page = parse_listing(fixture, BASE_URL);
        assert!(!page.sounds.is_empty());
        assert_fixture_sounds_are_well_formed(&page.sounds);
    }

    fn assert_fixture_sounds_are_well_formed(sounds: &[crate::RemoteSound]) {
        assert!(sounds.iter().all(|sound| !sound.title.trim().is_empty()));
        for sound in sounds {
            let mp3_url = Url::parse(&sound.mp3_url).expect("absolute MP3 URL");
            let page_url = Url::parse(&sound.page_url).expect("absolute page URL");
            assert!(matches!(mp3_url.scheme(), "http" | "https"));
            assert!(matches!(page_url.scheme(), "http" | "https"));
            assert!(mp3_url.host_str().is_some());
            assert!(page_url.host_str().is_some());
        }
    }
}
