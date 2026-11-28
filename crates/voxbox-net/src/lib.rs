//! URL helpers shared by VoxBox's download clients (voice-models.com, the Voix IA pack). Each
//! client keeps its own policy of which URLs it follows; only the comparisons live here.

use url::Url;

/// Same scheme, same host (case-insensitive) and same effective port: the client's own origin,
/// e.g. a local test server that is allowed plain http.
pub fn same_origin(base: &Url, target: &Url) -> bool {
    base.scheme() == target.scheme()
        && base
            .host_str()
            .zip(target.host_str())
            .is_some_and(|(a, b)| a.eq_ignore_ascii_case(b))
        && base.port_or_known_default() == target.port_or_known_default()
}

#[cfg(test)]
mod tests {
    use super::same_origin;
    use url::Url;

    #[test]
    fn compares_scheme_host_and_effective_port() {
        let base = Url::parse("https://Example.com/api").unwrap();
        let same = |url: &str| same_origin(&base, &Url::parse(url).unwrap());
        assert!(
            same("https://example.com:443/other"),
            "default port, host case"
        );
        assert!(!same("http://example.com/"), "scheme");
        assert!(!same("https://example.org/"), "host");
        assert!(!same("https://example.com:8443/"), "port");
        assert!(
            !same_origin(
                &Url::parse("file:///a").unwrap(),
                &Url::parse("file:///b").unwrap()
            ),
            "no host"
        );
    }
}
