//! JSON the way JavaScript writes it. The Node host did
//! `JSON.stringify(JSON.parse(msg))` for every browser message and
//! `JSON.stringify(part)` for every part frame; this module gives the same
//! bytes: JavaScript's string escaping (on UTF-16 code units, so a surrogate
//! pair cut in two becomes `\udxxx` escapes), its number spelling, and its
//! object key order (array-index keys first, ascending, then the rest in the
//! order they first appeared; a repeated key keeps its first place and its
//! last value).

use std::collections::HashMap;

/// Writes `units` as a JSON string, escaped as `JSON.stringify` does.
pub fn write_str16(out: &mut Vec<u8>, units: &[u16]) {
    out.push(b'"');
    let mut i = 0;
    while i < units.len() {
        let u = units[i];
        match u {
            0x22 => out.extend_from_slice(b"\\\""),
            0x5c => out.extend_from_slice(b"\\\\"),
            0x08 => out.extend_from_slice(b"\\b"),
            0x0c => out.extend_from_slice(b"\\f"),
            0x0a => out.extend_from_slice(b"\\n"),
            0x0d => out.extend_from_slice(b"\\r"),
            0x09 => out.extend_from_slice(b"\\t"),
            0..=0x1f => hex_escape(out, u),
            0xd800..=0xdbff if i + 1 < units.len() && (0xdc00..=0xdfff).contains(&units[i + 1]) => {
                let c = 0x10000 + (((u as u32) - 0xd800) << 10) + ((units[i + 1] as u32) - 0xdc00);
                push_char(out, char::from_u32(c).unwrap_or('\u{fffd}'));
                i += 1;
            }
            0xd800..=0xdfff => hex_escape(out, u),
            _ => push_char(out, char::from_u32(u as u32).unwrap_or('\u{fffd}')),
        }
        i += 1;
    }
    out.push(b'"');
}

/// Writes `s` as a JSON string (a Rust string has no lone surrogates, so this is `write_str16` without the detour).
pub fn write_str(out: &mut Vec<u8>, s: &str) {
    out.push(b'"');
    let mut plain = 0;
    let b = s.as_bytes();
    for (i, &c) in b.iter().enumerate() {
        let esc: Option<&[u8]> = match c {
            b'"' => Some(b"\\\""),
            b'\\' => Some(b"\\\\"),
            0x08 => Some(b"\\b"),
            0x0c => Some(b"\\f"),
            b'\n' => Some(b"\\n"),
            b'\r' => Some(b"\\r"),
            b'\t' => Some(b"\\t"),
            0..=0x1f => Some(b""),
            _ => None,
        };
        if let Some(e) = esc {
            out.extend_from_slice(&b[plain..i]);
            if e.is_empty() {
                hex_escape(out, c as u16)
            } else {
                out.extend_from_slice(e)
            }
            plain = i + 1;
        }
    }
    out.extend_from_slice(&b[plain..]);
    out.push(b'"');
}

fn hex_escape(out: &mut Vec<u8>, u: u16) {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    out.extend_from_slice(b"\\u");
    for shift in [12, 8, 4, 0] {
        out.push(HEX[((u >> shift) & 0xf) as usize]);
    }
}

fn push_char(out: &mut Vec<u8>, c: char) {
    let mut buf = [0u8; 4];
    out.extend_from_slice(c.encode_utf8(&mut buf).as_bytes());
}

/// `Number.prototype.toString()` for a JSON number (`null` for what overflowed to Infinity, as `JSON.stringify` does).
pub fn js_number(v: f64) -> String {
    if !v.is_finite() {
        return "null".into();
    }
    if v == 0.0 {
        return "0".into();
    }
    let sign = if v < 0.0 { "-" } else { "" };
    // Rust's shortest round-trip digits, like JavaScript's.
    let sci = format!("{:e}", v.abs());
    let (mant, exp) = sci.split_once('e').unwrap_or((&sci, "0"));
    let digits: String = mant.chars().filter(|c| *c != '.').collect();
    let k = digits.len() as i64;
    let n = exp.parse::<i64>().unwrap_or(0) + 1;
    let body = if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let rest = if k > 1 {
            format!(".{}", &digits[1..])
        } else {
            String::new()
        };
        let e = n - 1;
        format!("{}{rest}e{}{}", &digits[..1], if e >= 0 { "+" } else { "-" }, e.abs())
    };
    format!("{sign}{body}")
}

enum Value {
    Null,
    Bool(bool),
    Num(f64),
    Str(Vec<u16>),
    Arr(Vec<Value>),
    Obj(Vec<(Vec<u16>, Value)>),
}

const MAX_DEPTH: usize = 4096;

struct Parser<'a> {
    b: &'a [u8],
    i: usize,
}

type R<T> = Result<T, String>;

impl Parser<'_> {
    fn err<T>(&self, what: &str) -> R<T> {
        Err(format!("{what} at byte {}", self.i))
    }
    fn ws(&mut self) {
        while self.i < self.b.len() && matches!(self.b[self.i], b' ' | b'\t' | b'\n' | b'\r') {
            self.i += 1;
        }
    }
    fn lit(&mut self, word: &[u8], v: Value) -> R<Value> {
        if self.b[self.i..].starts_with(word) {
            self.i += word.len();
            Ok(v)
        } else {
            self.err("unexpected token")
        }
    }
    fn value(&mut self, depth: usize) -> R<Value> {
        if depth > MAX_DEPTH {
            return self.err("nested too deep");
        }
        self.ws();
        match self.b.get(self.i) {
            None => self.err("unexpected end"),
            Some(b'n') => self.lit(b"null", Value::Null),
            Some(b't') => self.lit(b"true", Value::Bool(true)),
            Some(b'f') => self.lit(b"false", Value::Bool(false)),
            Some(b'"') => Ok(Value::Str(self.string()?)),
            Some(b'[') => {
                self.i += 1;
                let mut items = Vec::new();
                self.ws();
                if self.b.get(self.i) == Some(&b']') {
                    self.i += 1;
                    return Ok(Value::Arr(items));
                }
                loop {
                    items.push(self.value(depth + 1)?);
                    self.ws();
                    match self.b.get(self.i) {
                        Some(b',') => self.i += 1,
                        Some(b']') => {
                            self.i += 1;
                            return Ok(Value::Arr(items));
                        }
                        _ => return self.err("expected , or ]"),
                    }
                }
            }
            Some(b'{') => {
                self.i += 1;
                let mut obj = Obj::default();
                self.ws();
                if self.b.get(self.i) == Some(&b'}') {
                    self.i += 1;
                    return Ok(Value::Obj(obj.entries));
                }
                loop {
                    self.ws();
                    if self.b.get(self.i) != Some(&b'"') {
                        return self.err("expected a key");
                    }
                    let k = self.string()?;
                    self.ws();
                    if self.b.get(self.i) != Some(&b':') {
                        return self.err("expected :");
                    }
                    self.i += 1;
                    let v = self.value(depth + 1)?;
                    obj.set(k, v);
                    self.ws();
                    match self.b.get(self.i) {
                        Some(b',') => self.i += 1,
                        Some(b'}') => {
                            self.i += 1;
                            return Ok(Value::Obj(obj.entries));
                        }
                        _ => return self.err("expected , or }"),
                    }
                }
            }
            Some(b'-' | b'0'..=b'9') => self.number(),
            _ => self.err("unexpected token"),
        }
    }
    fn digits(&mut self) -> usize {
        let s = self.i;
        while self.i < self.b.len() && self.b[self.i].is_ascii_digit() {
            self.i += 1;
        }
        self.i - s
    }
    fn number(&mut self) -> R<Value> {
        let start = self.i;
        if self.b[self.i] == b'-' {
            self.i += 1;
        }
        match self.b.get(self.i) {
            Some(b'0') => self.i += 1,
            Some(b'1'..=b'9') => {
                self.digits();
            }
            _ => return self.err("bad number"),
        }
        if self.b.get(self.i) == Some(&b'.') {
            self.i += 1;
            if self.digits() == 0 {
                return self.err("bad number");
            }
        }
        if matches!(self.b.get(self.i), Some(b'e' | b'E')) {
            self.i += 1;
            if matches!(self.b.get(self.i), Some(b'+' | b'-')) {
                self.i += 1;
            }
            if self.digits() == 0 {
                return self.err("bad number");
            }
        }
        let text = std::str::from_utf8(&self.b[start..self.i]).unwrap_or("0");
        text.parse::<f64>().map(Value::Num).map_err(|e| e.to_string())
    }
    fn hex4(&mut self) -> R<u16> {
        let h = self
            .b
            .get(self.i..self.i + 4)
            .ok_or_else(|| format!("bad \\u escape at byte {}", self.i))?;
        let s = std::str::from_utf8(h).map_err(|e| e.to_string())?;
        if !s.bytes().all(|c| c.is_ascii_hexdigit()) {
            return self.err("bad \\u escape");
        }
        self.i += 4;
        u16::from_str_radix(s, 16).map_err(|e| e.to_string())
    }
    fn string(&mut self) -> R<Vec<u16>> {
        self.i += 1; // "
        let mut out: Vec<u16> = Vec::new();
        loop {
            let run = self.i;
            while self.i < self.b.len() && !matches!(self.b[self.i], b'"' | b'\\' | 0..=0x1f) {
                self.i += 1;
            }
            // The input came from a &str: a run between ASCII delimiters is whole UTF-8.
            out.extend(
                std::str::from_utf8(&self.b[run..self.i])
                    .map_err(|e| e.to_string())?
                    .encode_utf16(),
            );
            match self.b.get(self.i) {
                None => return self.err("unterminated string"),
                Some(b'"') => {
                    self.i += 1;
                    return Ok(out);
                }
                Some(b'\\') => {
                    self.i += 1;
                    let e = *self.b.get(self.i).ok_or_else(|| "unterminated string".to_string())?;
                    self.i += 1;
                    out.push(match e {
                        b'"' => 0x22,
                        b'\\' => 0x5c,
                        b'/' => 0x2f,
                        b'b' => 0x08,
                        b'f' => 0x0c,
                        b'n' => 0x0a,
                        b'r' => 0x0d,
                        b't' => 0x09,
                        b'u' => self.hex4()?,
                        _ => return self.err("bad escape"),
                    });
                }
                Some(_) => return self.err("control character in string"),
            }
        }
    }
}

/// An object as `JSON.parse` builds it: a repeated key keeps its place and takes the new value.
#[derive(Default)]
struct Obj {
    entries: Vec<(Vec<u16>, Value)>,
    index: Option<HashMap<Vec<u16>, usize>>,
}

impl Obj {
    fn set(&mut self, k: Vec<u16>, v: Value) {
        if self.index.is_none() && self.entries.len() >= 16 {
            self.index = Some(
                self.entries
                    .iter()
                    .enumerate()
                    .map(|(i, (k, _))| (k.clone(), i))
                    .collect(),
            );
        }
        let at = match &self.index {
            Some(ix) => ix.get(&k).copied(),
            None => self.entries.iter().position(|(x, _)| *x == k),
        };
        match at {
            Some(i) => self.entries[i].1 = v,
            None => {
                if let Some(ix) = &mut self.index {
                    ix.insert(k.clone(), self.entries.len());
                }
                self.entries.push((k, v));
            }
        }
    }
}

/// An array index key ("0", "7", "42"… below 2³²−1): JavaScript lists those first, in numeric order.
fn array_index(k: &[u16]) -> Option<u32> {
    if k.is_empty() || k.len() > 10 || (k.len() > 1 && k[0] == u16::from(b'0')) {
        return None;
    }
    let mut n: u64 = 0;
    for &u in k {
        if !(0x30..=0x39).contains(&u) {
            return None;
        }
        n = n * 10 + u64::from(u - 0x30);
    }
    (n < 0xffff_ffff).then_some(n as u32)
}

fn write(out: &mut Vec<u8>, v: &Value) {
    match v {
        Value::Null => out.extend_from_slice(b"null"),
        Value::Bool(true) => out.extend_from_slice(b"true"),
        Value::Bool(false) => out.extend_from_slice(b"false"),
        Value::Num(n) => out.extend_from_slice(js_number(*n).as_bytes()),
        Value::Str(s) => write_str16(out, s),
        Value::Arr(items) => {
            out.push(b'[');
            for (i, x) in items.iter().enumerate() {
                if i > 0 {
                    out.push(b',');
                }
                write(out, x);
            }
            out.push(b']');
        }
        Value::Obj(entries) => {
            let mut order: Vec<usize> = (0..entries.len()).collect();
            let idx: Vec<Option<u32>> = entries.iter().map(|(k, _)| array_index(k)).collect();
            if idx.iter().any(Option::is_some) {
                // Stable: indexes ascending first, the other keys keep their order.
                order.sort_by_key(|&i| match idx[i] {
                    Some(n) => (0, n),
                    None => (1, 0),
                });
            }
            out.push(b'{');
            for (j, &i) in order.iter().enumerate() {
                if j > 0 {
                    out.push(b',');
                }
                write_str16(out, &entries[i].0);
                out.push(b':');
                write(out, &entries[i].1);
            }
            out.push(b'}');
        }
    }
}

/// `JSON.stringify(JSON.parse(text))`.
pub fn normalize(text: &str) -> Result<Vec<u8>, String> {
    let mut p = Parser {
        b: text.as_bytes(),
        i: 0,
    };
    let v = p.value(0)?;
    p.ws();
    if p.i != p.b.len() {
        return p.err("unexpected data after JSON");
    }
    let mut out = Vec::with_capacity(text.len());
    write(&mut out, &v);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn n(s: &str) -> String {
        String::from_utf8(normalize(s).unwrap()).unwrap()
    }

    #[test]
    fn numbers_spelled_like_javascript() {
        for (x, js) in [
            ("1.0", "1"),
            ("-0", "0"),
            ("1e2", "100"),
            ("1700000000000.0", "1700000000000"),
            ("0.1", "0.1"),
            ("1e21", "1e+21"),
            ("123456789012345678901", "123456789012345680000"),
            ("1e-7", "1e-7"),
            ("0.000001", "0.000001"),
            ("1.5e-7", "1.5e-7"),
            ("12345678901234567890", "12345678901234567000"),
            ("1e400", "null"),
            ("-1e400", "null"),
            ("1e-400", "0"),
            ("5e-324", "5e-324"),
            ("1.7976931348623157e308", "1.7976931348623157e+308"),
            ("-2.5", "-2.5"),
            ("100E-2", "1"),
        ] {
            assert_eq!(n(x), js, "{x}");
        }
    }

    #[test]
    fn strings_escaped_like_javascript() {
        assert_eq!(n(r#""\u0041\/\u00e9 é""#), "\"A/é é\"");
        assert_eq!(n(r#""\u0001\u001f\b\f\n\r\t\"\\""#), r#""\u0001\u001f\b\f\n\r\t\"\\""#);
        assert_eq!(n(r#""\uD83D\uDE00""#), "\"😀\"");
        assert_eq!(n(r#""\ud800x\udc00""#), r#""\ud800x\udc00""#);
        assert_eq!(n("\"\u{2028}\u{7f}\""), "\"\u{2028}\u{7f}\"");
    }

    #[test]
    fn objects_ordered_like_javascript() {
        assert_eq!(
            n(r#" { "b" : 1 , "a" : [ 1 , 2 ] , "b" : 3 } "#),
            r#"{"b":3,"a":[1,2]}"#
        );
        assert_eq!(
            n(r#"{"x":1,"10":2,"2":3,"01":4,"4294967295":5,"4294967294":6}"#),
            r#"{"2":3,"10":2,"4294967294":6,"x":1,"01":4,"4294967295":5}"#
        );
        assert_eq!(n(r#"{"__proto__":1}"#), r#"{"__proto__":1}"#);
        let many: Vec<String> = (0..40).map(|i| format!("\"k{}\":{i}", i % 20)).collect();
        assert_eq!(
            n(&format!("{{{}}}", many.join(","))),
            format!(
                "{{{}}}",
                (0..20)
                    .map(|i| format!("\"k{i}\":{}", i + 20))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        );
    }

    #[test]
    fn rejects_what_json_parse_rejects() {
        for bad in [
            "",
            "01",
            "1.",
            ".5",
            "+1",
            "[1,]",
            "{\"a\" 1}",
            "\"\n\"",
            "'a'",
            "nul",
            "1 2",
            "\"\\x\"",
            "\"\\u12\"",
            "{,}",
            "-",
        ] {
            assert!(normalize(bad).is_err(), "{bad:?}");
        }
        assert_eq!(n(" \t\r\n[]\n"), "[]");
    }

    #[test]
    fn str_and_str16_agree() {
        let s = "a\"b\\c\u{1}\u{7}\n😀é";
        let mut a = Vec::new();
        write_str(&mut a, s);
        let mut b = Vec::new();
        write_str16(&mut b, &s.encode_utf16().collect::<Vec<_>>());
        assert_eq!(a, b);
    }
}
