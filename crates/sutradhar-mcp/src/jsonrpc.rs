//! Just enough JSON to route JSON-RPC lines: the top-level `id` (as its raw
//! text), `method`, and whether `result` or `error` is there. No values are
//! decoded beyond that; anything unexpected reads as "no fields".

/// What the pipe needs to know about one message.
#[derive(Debug, Default, PartialEq)]
pub struct Msg {
    /// The raw `id` value (`1`, `"abc"`), and where it sits in the line.
    pub id: Option<(String, usize, usize)>,
    pub method: Option<String>,
    /// `result` or `error` is present: this is a response.
    pub reply: bool,
}

impl Msg {
    /// A request: it has a method and an id, so it waits for an answer.
    pub fn is_request(&self) -> bool {
        self.method.is_some() && self.id.is_some()
    }
    pub fn id(&self) -> Option<&str> {
        self.id.as_ref().map(|(s, _, _)| s.as_str())
    }
}

fn ws(b: &[u8], mut i: usize) -> usize {
    while i < b.len() && matches!(b[i], b' ' | b'\t' | b'\r' | b'\n') {
        i += 1;
    }
    i
}

/// End (exclusive) of the string starting at b[i] == '"'.
fn string_end(b: &[u8], mut i: usize) -> Option<usize> {
    i += 1;
    while i < b.len() {
        match b[i] {
            b'\\' => i += 2,
            b'"' => return Some(i + 1),
            _ => i += 1,
        }
    }
    None
}

/// End (exclusive) of the value starting at b[i].
fn value_end(b: &[u8], i: usize) -> Option<usize> {
    match *b.get(i)? {
        b'"' => string_end(b, i),
        b'{' | b'[' => {
            let mut depth = 0usize;
            let mut j = i;
            while j < b.len() {
                match b[j] {
                    b'"' => {
                        j = string_end(b, j)?;
                        continue;
                    }
                    b'{' | b'[' => depth += 1,
                    b'}' | b']' => {
                        depth -= 1;
                        if depth == 0 {
                            return Some(j + 1);
                        }
                    }
                    _ => {}
                }
                j += 1;
            }
            None
        }
        _ => {
            let mut j = i;
            while j < b.len() && !matches!(b[j], b',' | b'}' | b']' | b' ' | b'\t' | b'\r' | b'\n') {
                j += 1;
            }
            (j > i).then_some(j)
        }
    }
}

/// Reads the top-level fields of one JSON-RPC message.
pub fn parse(line: &[u8]) -> Msg {
    let mut m = Msg::default();
    let b = line;
    let mut i = ws(b, 0);
    if b.get(i) != Some(&b'{') {
        return Msg::default();
    }
    i = ws(b, i + 1);
    if b.get(i) == Some(&b'}') {
        return m;
    }
    loop {
        if b.get(i) != Some(&b'"') {
            return Msg::default();
        }
        let Some(kend) = string_end(b, i) else {
            return Msg::default();
        };
        let key = &b[i + 1..kend - 1];
        i = ws(b, kend);
        if b.get(i) != Some(&b':') {
            return Msg::default();
        }
        let vstart = ws(b, i + 1);
        let Some(vend) = value_end(b, vstart) else {
            return Msg::default();
        };
        let raw = &b[vstart..vend];
        match key {
            b"id" if raw != b"null" => m.id = Some((String::from_utf8_lossy(raw).into_owned(), vstart, vend)),
            b"method" if raw.first() == Some(&b'"') => {
                m.method = Some(String::from_utf8_lossy(&raw[1..raw.len() - 1]).into_owned())
            }
            b"result" | b"error" => m.reply = true,
            _ => {}
        }
        i = ws(b, vend);
        match b.get(i) {
            Some(b',') => i = ws(b, i + 1),
            Some(b'}') => return m,
            _ => return Msg::default(),
        }
    }
}

/// The line with its id replaced by `id` (raw JSON).
pub fn with_id(line: &[u8], msg: &Msg, id: &str) -> Vec<u8> {
    let Some((_, s, e)) = msg.id else { return line.to_vec() };
    let mut out = Vec::with_capacity(line.len() + id.len());
    out.extend_from_slice(&line[..s]);
    out.extend_from_slice(id.as_bytes());
    out.extend_from_slice(&line[e..]);
    out
}

/// A JSON-RPC error answer to the request with this raw id.
pub fn error_line(id: &str, message: &str) -> Vec<u8> {
    format!(
        "{{\"jsonrpc\":\"2.0\",\"id\":{id},\"error\":{{\"code\":-32000,\"message\":{}}}}}\n",
        crate::json_string(message)
    )
    .into_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requests_responses_notifications() {
        let r =
            parse(br#"{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"x","arguments":{"s":"}\"{"}}}"#);
        assert_eq!(r.id(), Some("7"));
        assert_eq!(r.method.as_deref(), Some("tools/call"));
        assert!(r.is_request() && !r.reply);
        let r = parse(br#" { "result" : {"a":[1,{"b":"]"}]}, "id" : "abc", "jsonrpc":"2.0" }"#);
        assert_eq!(r.id(), Some("\"abc\""));
        assert!(r.reply && !r.is_request());
        let r = parse(br#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#);
        assert_eq!(r.method.as_deref(), Some("notifications/initialized"));
        assert!(!r.is_request());
        assert_eq!(parse(br#"{"id":null,"error":{"code":1}}"#).id(), None);
    }

    #[test]
    fn junk_reads_as_nothing() {
        for junk in [&b""[..], b"[1,2]", b"{", b"{\"id\":", b"{\"id\" 1}", b"not json"] {
            assert_eq!(parse(junk), Msg::default(), "{:?}", String::from_utf8_lossy(junk));
        }
    }

    #[test]
    fn ids_are_replaced_and_errors_written() {
        let line = br#"{"jsonrpc":"2.0","id":0,"method":"initialize","params":{}}"#;
        let out = with_id(line, &parse(line), "\"pipe-reinit-1\"");
        assert_eq!(
            out,
            br#"{"jsonrpc":"2.0","id":"pipe-reinit-1","method":"initialize","params":{}}"#
        );
        let e = error_line("\"q\"", "gone");
        assert_eq!(
            e,
            b"{\"jsonrpc\":\"2.0\",\"id\":\"q\",\"error\":{\"code\":-32000,\"message\":\"gone\"}}\n"
        );
        assert_eq!(parse(&e).id(), Some("\"q\""));
    }
}
