from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import base64
import hashlib
import hmac
import json
import os
import time
import urllib.error
import urllib.request


ROOT = Path(__file__).resolve().parent
DATA_FILE = ROOT / "data.json"
LINE_EVENTS_FILE = ROOT / "line_events.json"
LINE_CONFIG_FILE = ROOT / "line_config.json"
LINE_REPLY_URL = "https://api.line.me/v2/bot/message/reply"
OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions"


class HarnkanHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Line-Signature")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/api/state":
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            if DATA_FILE.exists():
                self.wfile.write(DATA_FILE.read_bytes())
            else:
                self.wfile.write(b"{}")
            return
        if path == "/api/line/config":
            self.send_json(200, {
                "ok": True,
                "webhookPath": "/line/webhook",
                "channelSecretConfigured": bool(line_channel_secret()),
                "channelAccessTokenConfigured": bool(line_channel_access_token()),
                "openaiApiKeyConfigured": bool(openai_api_key()),
                "aiReplyEnabled": bool(openai_api_key()),
                "configFileEnabled": LINE_CONFIG_FILE.exists(),
            })
            return
        if path == "/api/line/events":
            self.send_json(200, {"ok": True, "events": read_line_events()})
            return
        super().do_GET()

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        if path == "/api/line/config":
            self.handle_line_config_save()
            return
        if path == "/line/webhook":
            self.handle_line_webhook()
            return
        if path != "/api/state":
            self.send_error(404)
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length)
            payload = json.loads(raw.decode("utf-8"))
            DATA_FILE.write_text(
                json.dumps(payload, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(b'{"ok":true}')
        except Exception as exc:
            self.send_json(400, {"ok": False, "error": str(exc)})

    def handle_line_webhook(self):
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length)
        signature = self.headers.get("X-Line-Signature", "")
        channel_secret = line_channel_secret()

        if channel_secret and not verify_line_signature(raw, signature, channel_secret):
            self.send_json(401, {"ok": False, "error": "Invalid LINE signature"})
            return

        try:
            payload = json.loads(raw.decode("utf-8") or "{}")
        except Exception as exc:
            self.send_json(400, {"ok": False, "error": f"Invalid JSON: {exc}"})
            return

        events = payload.get("events", [])
        stored = {
            "receivedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "destination": payload.get("destination", ""),
            "eventCount": len(events),
            "signatureVerified": bool(channel_secret),
            "events": summarize_line_events(events),
        }
        append_line_event(stored)

        replies = []
        for event in events:
            reply_result = reply_to_line_event(event)
            if reply_result:
                replies.append(reply_result)

        self.send_json(200, {
            "ok": True,
            "eventCount": len(events),
            "signatureVerified": bool(channel_secret),
            "replies": replies,
        })

    def handle_line_config_save(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length)
            payload = json.loads(raw.decode("utf-8") or "{}")
            secret = str(payload.get("channelSecret", "")).strip()
            token = str(payload.get("channelAccessToken", "")).strip()
            if not secret or not token:
                self.send_json(400, {"ok": False, "error": "Channel Secret และ Channel Access Token ต้องไม่ว่าง"})
                return
            LINE_CONFIG_FILE.write_text(
                json.dumps(
                    {"channelSecret": secret, "channelAccessToken": token},
                    ensure_ascii=False,
                    indent=2,
                ),
                encoding="utf-8",
            )
            self.send_json(200, {
                "ok": True,
                "channelSecretConfigured": True,
                "channelAccessTokenConfigured": True,
                "configFileEnabled": True,
            })
        except Exception as exc:
            self.send_json(400, {"ok": False, "error": str(exc)})

    def send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def verify_line_signature(raw_body, signature, channel_secret):
    if not signature:
        return False
    digest = hmac.new(channel_secret.encode("utf-8"), raw_body, hashlib.sha256).digest()
    expected = base64.b64encode(digest).decode("utf-8")
    return hmac.compare_digest(expected, signature)


def read_line_events():
    if not LINE_EVENTS_FILE.exists():
        return []
    try:
        return json.loads(LINE_EVENTS_FILE.read_text(encoding="utf-8"))
    except Exception:
        return []


def read_line_config():
    if not LINE_CONFIG_FILE.exists():
        return {}
    try:
        return json.loads(LINE_CONFIG_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}


def line_channel_secret():
    return os.environ.get("LINE_CHANNEL_SECRET") or read_line_config().get("channelSecret", "")


def line_channel_access_token():
    return os.environ.get("LINE_CHANNEL_ACCESS_TOKEN") or read_line_config().get("channelAccessToken", "")


def read_local_env():
    values = {}
    for name in (".env.local", ".env"):
        path = ROOT / name
        if not path.exists():
            continue
        for line in path.read_text(encoding="utf-8").splitlines():
            clean = line.strip()
            if not clean or clean.startswith("#") or "=" not in clean:
                continue
            key, value = clean.split("=", 1)
            values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def openai_api_key():
    return os.environ.get("OPENAI_API_KEY") or read_local_env().get("OPENAI_API_KEY", "")


def openai_model():
    return os.environ.get("OPENAI_MODEL") or read_local_env().get("OPENAI_MODEL", "gpt-4o-mini")


def append_line_event(entry):
    events = read_line_events()
    events.insert(0, entry)
    LINE_EVENTS_FILE.write_text(
        json.dumps(events[:50], ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def summarize_line_events(events):
    summaries = []
    for event in events:
        message = event.get("message") or {}
        source = event.get("source") or {}
        summaries.append({
            "type": event.get("type", ""),
            "replyToken": event.get("replyToken", ""),
            "sourceType": source.get("type", ""),
            "userId": source.get("userId", ""),
            "messageType": message.get("type", ""),
            "text": message.get("text", ""),
        })
    return summaries


def reply_to_line_event(event):
    token = line_channel_access_token()
    reply_token = event.get("replyToken")
    message = event.get("message") or {}
    if not token or not reply_token or message.get("type") != "text":
        return None

    text = (message.get("text") or "").strip()
    reply_text = build_openai_reply_text(text) or build_line_reply_text(text)
    payload = {
        "replyToken": reply_token,
        "messages": [{"type": "text", "text": reply_text}],
    }
    request = urllib.request.Request(
        LINE_REPLY_URL,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return {"ok": 200 <= response.status < 300, "status": response.status}
    except urllib.error.HTTPError as exc:
        return {"ok": False, "status": exc.code, "error": exc.read().decode("utf-8", "ignore")[:300]}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def build_line_reply_text(text):
    lowered = text.lower()
    if lowered in {"สรุป", "ยอด", "summary"}:
        return "เปิดเว็บหารกันเพื่อดูสรุปยอดล่าสุดได้เลยครับ"
    if lowered in {"help", "ช่วยเหลือ"}:
        return "พิมพ์ 'สรุป' เพื่อให้บอทตอบลิงก์/คำแนะนำสรุปยอด หรือส่งข้อความอื่นเพื่อทดสอบ webhook"
    return f"บอทหารกันได้รับข้อความแล้ว: {text}"


def build_openai_reply_text(text):
    key = openai_api_key()
    if not key:
        return ""

    payload = {
        "model": openai_model(),
        "temperature": 0.4,
        "max_tokens": 500,
        "messages": [
            {
                "role": "system",
                "content": "คุณคือผู้ช่วยของเว็บหารกัน ตอบภาษาไทยแบบสั้น ชัดเจน เป็นกันเอง ช่วยอธิบายการหารเงิน ยอดโอน ทริป ค่าใช้จ่าย และวิธีใช้เว็บ หากข้อมูลไม่พอให้ถามกลับสั้น ๆ",
            },
            {"role": "user", "content": text},
        ],
    }
    request = urllib.request.Request(
        OPENAI_CHAT_URL,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {key}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            data = json.loads(response.read().decode("utf-8"))
            return (data.get("choices", [{}])[0].get("message", {}).get("content") or "").strip()
    except Exception as exc:
        print(f"OpenAI reply failed: {exc}")
        return ""


def run():
    server = ThreadingHTTPServer(("0.0.0.0", 4174), HarnkanHandler)
    print("Harnkan LAN server running at http://0.0.0.0:4174")
    server.serve_forever()


if __name__ == "__main__":
    run()
