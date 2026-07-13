export const MALICIOUS_HTML_CASES = [
  ["document element", "<!doctype html><html><body>owned</body></html>"],
  ["head element", "<head><meta name='x' content='y'></head><main>owned</main>"],
  ["script", "<section><script>alert(1)</script></section>"],
  ["form", "<form action='/steal'><input name='card'></form>"],
  ["iframe", "<iframe src='https://evil.example'></iframe>"],
  ["event handler", "<button onclick='alert(1)'>Buy</button>"],
  ["worker-like custom element", "<worker src='https://evil.example/worker.js'></worker>"],
  ["remote image source", "<img src='https://evil.example/pixel.gif' alt='x'>"],
] as const;

export const MALICIOUS_CSS_CASES = [
  ["import", "@import 'https://evil.example/x.css';"],
  ["font face", "@font-face { font-family: pwn; src: url(https://evil.example/pwn.woff2) }"],
  ["external url", ".card { background: url(https://evil.example/pixel.gif) }"],
  ["escaping selector", "body .card { color: red }"],
  ["protected checkout selector", "[data-cd-protected='checkoutRoot'] { opacity: 0 }"],
] as const;
