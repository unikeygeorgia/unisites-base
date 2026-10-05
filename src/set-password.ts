import type { Locale } from "./messages.ts";

/**
 * Base's own page for the link in an invitation or a reset letter, so both
 * work in any project, with or without a page of its own. better-auth's
 * /reset-password/:token checks the token and sends the person here with it
 * (?token=…, or ?error=INVALID_TOKEN); the page posts the new password to
 * /reset-password on the same origin.
 *
 * The token is in the address: the page drops it from the history at once,
 * sends no referrer, is never cached, and runs only its own script.
 */

const TEXT = {
  en: {
    bad: "This link no longer works: it was used, or it is too old. Ask for a new one.",
    done: "Your password is set.",
    failed: "The password was not set. Try again.",
    lead: "Choose a password for your account.",
    leaked: "This password was found in a data leak. Choose another one.",
    next: "Sign in",
    password: "New password",
    save: "Set the password",
    short: "At least 8 characters.",
    title: "A new password",
  },
  ka: {
    bad: "ბმული აღარ მოქმედებს: გამოყენებულია, ან ვადა გაუვიდა. მოითხოვე ახალი.",
    done: "პაროლი დაყენებულია.",
    failed: "პაროლი ვერ დაყენდა. სცადე თავიდან.",
    lead: "აირჩიე პაროლი შენი ანგარიშისთვის.",
    leaked: "ეს პაროლი მონაცემების გაჟონვაში აღმოჩნდა. აირჩიე სხვა.",
    next: "შესვლა",
    password: "ახალი პაროლი",
    save: "პაროლის დაყენება",
    short: "მინიმუმ 8 სიმბოლო.",
    title: "ახალი პაროლი",
  },
} satisfies Record<Locale, Record<string, string>>;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function setPasswordPage({ app, locale, next, post }: { app: string; locale: Locale; next: string; post: string }): Response {
  const t = TEXT[locale];
  const nonce = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
  // Only what the script needs, as JSON in a data block: nothing from the address is written into the HTML.
  const data = JSON.stringify({ bad: t.bad, done: t.done, failed: t.failed, leaked: t.leaked, post, short: t.short }).replace(/</g, "\\u003c");
  const html = `<!doctype html>
<html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><meta name="robots" content="noindex">
<title>${esc(app)}: ${esc(t.title)}</title>
<style>
:root{color-scheme:light dark;--bg:#fff;--fg:#12131a;--muted:#5b5f6b;--line:#d9dbe1;--bad:#b42318}
@media (prefers-color-scheme:dark){:root{--bg:#111216;--fg:#f2f3f5;--muted:#a0a4ae;--line:#33353d;--bad:#ff8a7a}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px 16px;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{width:100%;max-width:380px}h1{font-size:22px;margin:0 0 4px}p{margin:0 0 20px;color:var(--muted)}
label{display:block;font-weight:600;margin-bottom:6px}input{width:100%;font:inherit;padding:11px 12px;border:1px solid var(--line);border-radius:10px;background:transparent;color:inherit}
button,a.next{display:inline-block;margin-top:16px;width:100%;text-align:center;font:inherit;font-weight:700;padding:12px;border:0;border-radius:999px;background:var(--fg);color:var(--bg);text-decoration:none;cursor:pointer}
button[disabled]{opacity:.6;cursor:default}#note{min-height:1.5em;margin:10px 0 0;color:var(--bad)}[hidden]{display:none!important}
</style></head>
<body><main>
<h1>${esc(app)}</h1>
<section id="form"><p>${esc(t.lead)}</p>
<form><label for="pw">${esc(t.password)}</label><input id="pw" type="password" autocomplete="new-password" minlength="8" maxlength="128" required>
<p id="note" role="alert"></p><button type="submit">${esc(t.save)}</button></form></section>
<section id="done" hidden><p>${esc(t.done)}</p><a class="next" href="${esc(next)}">${esc(t.next)}</a></section>
</main>
<script type="application/json" id="data">${data}</script>
<script nonce="${nonce}">
(function(){
  var d=JSON.parse(document.getElementById("data").textContent);
  var q=new URLSearchParams(location.search),token=q.get("token");
  history.replaceState(null,"",location.pathname);
  var note=document.getElementById("note"),form=document.querySelector("form"),btn=form.querySelector("button");
  if(!token){note.textContent=d.bad;form.querySelector("input").disabled=true;btn.disabled=true;return}
  form.addEventListener("submit",function(e){
    e.preventDefault();var pw=document.getElementById("pw").value;
    if(pw.length<8){note.textContent=d.short;return}
    btn.disabled=true;note.textContent="";
    fetch(d.post,{method:"POST",credentials:"same-origin",headers:{"content-type":"application/json"},body:JSON.stringify({newPassword:pw,token:token})})
      .then(function(r){return r.json().catch(function(){return null}).then(function(b){return{ok:r.ok,b:b}})})
      .then(function(x){
        if(x.ok){document.getElementById("form").hidden=true;document.getElementById("done").hidden=false;return}
        var c=x.b&&x.b.code||"";btn.disabled=false;
        note.textContent=c==="INVALID_TOKEN"?d.bad:c==="PASSWORD_TOO_SHORT"?d.short:c==="PASSWORD_COMPROMISED"?d.leaked:d.failed;
      },function(){btn.disabled=false;note.textContent=d.failed});
  });
})();
</script></body></html>`;
  return new Response(html, {
    headers: {
      "cache-control": "no-store",
      "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'`,
      "content-type": "text/html; charset=utf-8",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
}
