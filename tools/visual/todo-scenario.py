"""할 일 앱 정의를 로컬 시험 쉘에서 실제 조작으로 확인한다.

위임서(카드 87b15ec1)의 확인 항목 1~10을 순서대로 수행한다. 시험 쉘은 정의만
올리므로 store.json의 자산을 먼저 등록하고, 저장 항목을 채운 뒤 창을 다시 연다.
날짜가 든 표본은 실행일 기준으로 계산한다(todo-sample.json의 date/done은 일 오프셋).
"""

import base64
import hashlib
import json
import re
import shutil
import time
from datetime import date, timedelta
from pathlib import Path

from playwright.sync_api import expect

REPO = Path(__file__).resolve().parents[2]
APP_DIR = REPO / "apps" / "todo"
SAMPLE = Path(__file__).resolve().parent / "todo-sample.json"
OUT = Path(sb.out)
TODAY = date.today()


def log(*parts):
    print("[todo]", *parts, flush=True)


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def on_day(offset):
    return (TODAY + timedelta(days=int(offset))).isoformat()


def call(tool, args):
    res = sb.mcp.call(tool, args)
    if res["is_error"]:
        raise AssertionError(f"{tool} 실패: {res['text'][:800]}")
    return res["data"]


def wait_for(pred, what, timeout=15.0):
    end = time.time() + timeout
    last = None
    while time.time() < end:
        last = pred()
        if last:
            return last
        time.sleep(0.2)
    raise AssertionError(f"시간이 다 됐습니다: {what} (마지막 {last!r})")


definition = read_json(APP_DIR / "app.json")
store = read_json(APP_DIR / "store.json")
sample = read_json(SAMPLE)

# ── 표본 자료: 날짜 오프셋을 실행일 기준 날짜로 바꾼다 ──

sample_items = []
for spec in sample["items"]:
    sample_items.append({
        "id": spec["id"],
        "title": spec["title"],
        "area": spec["area"],
        "parent": spec["parent"],
        "status": spec["status"],
        "date": on_day(spec["date"]) if spec["date"] is not None else None,
        "wait": spec["wait"],
        "done_on": on_day(spec["done"]) if spec["done"] is not None else None,
        "created_on": on_day(-30),
        "order": spec["order"],
    })

# ── 자산과 앱, 저장소 준비 ──

for asset in store["assets"]:
    path = APP_DIR / asset["file"]
    payload = path.read_bytes()
    res = sb.mcp.call("upload_asset", {
        "id": asset["id"],
        "version": asset["version"],
        "format": asset["format"],
        "sha256": hashlib.sha256(payload).hexdigest(),
        "source": asset["source"],
        "license": asset["license"],
        "data_base64": base64.b64encode(payload).decode("ascii"),
    })
    if res["is_error"]:
        raise AssertionError(f"자산 등록 실패 {asset['id']}: {res['text'][:500]}")
    log("자산 등록", asset["id"], res["text"][:120])

uploaded = sb.mcp.call("upload_app", {"definition": definition, "open": False})
if uploaded["is_error"]:
    raise AssertionError(f"앱 등록 실패: {uploaded['text'][:800]}")
log("앱 등록", uploaded["text"][:160])


def read_storage(entry_id, doc=None):
    args = {"app_id": "todo", "entry_id": entry_id}
    if doc is not None:
        args["doc"] = doc
    res = sb.mcp.call("read_app_storage", args)
    if res["is_error"]:
        # 컬렉션 문서는 아직 쓰지 않았으면 not_found로 온다. 그때는 「없음」이다.
        if "STORAGE_DOCUMENT_READ_NOT_FOUND" in res["text"]:
            return None
        raise AssertionError(f"read_app_storage 실패: {res['text'][:800]}")
    return res["data"]


def put_storage(entry_id, content, doc=None):
    args = {"app_id": "todo", "entry_id": entry_id, "content": content}
    if doc is not None:
        args["doc"] = doc
    current = read_storage(entry_id, doc)
    if current and current.get("exists"):
        args["expected_revision"] = current["revision"]
    call("write_app_storage", args)


put_storage("items", sample_items)
put_storage("areas", sample["areas"])
for doc, body in sample["memos"].items():
    put_storage("memos", body, doc=doc)
log("표본 저장", len(sample_items), "항목,", len(sample["memos"]), "메모")

opened = sb.upload_and_open(definition)
if not opened.get("window_id"):
    raise AssertionError(f"앱 창이 열리지 않았습니다: {opened}")
wid = opened["window_id"]
log("창", wid)

sb.core({"op": "window.set_rect", "window_id": wid,
         "rect": {"x": 40, "y": 60, "width": 1040, "height": 700}})

win = sb.window("todo")


def row(item_id):
    return win.locator(f'button[data-tree-id="item:{item_id}"]')


def check_span(item_id):
    return row(item_id).locator("[data-tree-check]")


def section(name):
    # 왼쪽 반복 틀이 그린 섹션만 고른다. 오른쪽 상세의 「묶음」 선택 값도 같은 글자를
    # 담으므로, 반복 틀(template)로 한정하지 않으면 strict 모드에서 두 요소가 잡힌다.
    return win.locator('section.ks-data-section[data-ks-block$="/template"]').filter(has_text=name)


def items_now():
    return read_storage("items")["content"]


def item_now(item_id):
    return next((it for it in items_now() if it.get("id") == item_id), None)


def day_groups():
    return win.locator('button[data-tree-id^="item:day:"]')


def window_box():
    box = win.bounding_box()
    if not box:
        raise AssertionError("창 좌표를 읽지 못했습니다")
    return box


def set_size(width, height):
    sb.core({"op": "window.set_rect", "window_id": wid,
             "rect": {"x": 40, "y": 60, "width": width, "height": height}})
    end = time.time() + 15
    while time.time() < end:
        box = win.bounding_box()
        if box and abs(box["width"] - width) <= 4 and abs(box["height"] - height) <= 6:
            return
        time.sleep(0.2)
    raise AssertionError(f"창 크기가 {width}x{height}로 바뀌지 않았습니다: {win.bounding_box()}")


results = {}

# ── 1. 첫 화면: 묶음 구역, 펼친 트리, 취소선, 보류 배지, meta ──

wait_for(lambda: win.locator('button[role="treeitem"]').count() > 0, "트리 행이 그려짐")
expect(section("업무")).to_be_visible(timeout=15000)
expect(section("개인")).to_be_visible(timeout=15000)
expect(row("t-report")).to_be_visible()
expect(row("t-collect")).to_be_visible()   # 펼친 트리(자식이 보인다)
expect(row("t-draft")).to_be_visible()
expect(row("t-quote")).to_be_visible()
expect(row("t-milk")).to_be_visible()

expect(row("t-collect").locator(".ks-tree-name")).to_have_class(re.compile("is-checked"))
expect(row("t-collect").locator(".ks-tree-name")).to_have_css("text-decoration-line", re.compile("line-through"))
expect(row("t-quote").locator(".ks-badge")).to_have_text("보류")
expect(row("t-room").locator(".ks-view-meta")).to_have_text("내일")
expect(row("t-draft").locator(".ks-view-meta")).to_have_text("팀장 검토")
expect(row("t-collect").locator(".ks-view-meta")).to_have_text("어제")

# 상세 칸: 항목 하나를 골라 이름표 입력과 메모 문서를 확인한다.
row("t-draft").click()
expect(win.get_by_label("제목", exact=True)).to_have_value("초안 쓰기", timeout=10000)
expect(win.get_by_label("묶음", exact=True)).to_contain_text("업무")
expect(win.get_by_label("기다림", exact=True)).to_have_attribute("placeholder", "누구나 무엇을 기다리는지")
expect(win.get_by_label("기다림", exact=True)).to_have_value("팀장 검토")
expect(win.locator(".ks-data-window")).to_contain_text("초안 구성")
expect(win.get_by_role("button", name="지우기", exact=True)).to_be_visible()
expect(win.get_by_role("button", name="보류", exact=True)).to_be_visible()

sb.shot("wide-light.png", "todo", settle=0.5)
shutil.copyfile(OUT / "wide-light.png", APP_DIR / "screenshots" / "1.png")
results["wide"] = "ok"

# 2. 같은 화면 어두움
page.emulate_media(color_scheme="dark")
time.sleep(0.8)
sb.shot("wide-dark.png", "todo", settle=0.3)
shutil.copyfile(OUT / "wide-dark.png", APP_DIR / "screenshots" / "2.png")
page.emulate_media(color_scheme="light")
time.sleep(0.5)

# 1(이어서). 좁은 창 380에서도 구역과 트리가 그려진다.
set_size(380, 700)
expect(section("업무")).to_be_visible(timeout=15000)
expect(row("t-draft")).to_be_visible()
expect(row("t-collect").locator(".ks-tree-name")).to_have_class(re.compile("is-checked"))
expect(row("t-quote").locator(".ks-badge")).to_have_text("보류")
expect(row("t-room").locator(".ks-view-meta")).to_have_text("내일")
sb.shot("narrow-open.png", "todo", settle=0.5)
results["narrow_first_screen"] = "ok"
set_size(1040, 700)

# 3. 넓은 창 기록 보기(스크린샷 3)
win.get_by_role("button", name="기록", exact=True).click()
wait_for(lambda: day_groups().count() >= 3, "기록 보기 날짜 묶음")
expect(day_groups().filter(has_text="오늘").first).to_be_visible()
expect(day_groups().filter(has_text="어제").first).to_be_visible()
expect(day_groups().filter(has_text=re.compile(r"\d+월 \d+일 \([월화수목금토일]\)")).first).to_be_visible()
expect(row("t-collect").locator(".ks-view-meta")).to_contain_text("업무 · 분기 보고서")
expect(row("t-passport")).to_be_visible()
expect(row("t-library")).to_be_visible()
sb.shot("log-wide.png", "todo", settle=0.5)
shutil.copyfile(OUT / "log-wide.png", APP_DIR / "screenshots" / "3.png")
for index in (1, 2, 3):
    size = (APP_DIR / "screenshots" / f"{index}.png").stat().st_size
    assert size <= 2 * 1024 * 1024, f"{index}.png가 2MiB를 넘습니다: {size}"
results["log_screenshot"] = "ok"
win.get_by_role("button", name="할 일", exact=True).click()
expect(section("업무")).to_be_visible()

# ── 2. 체크 칸 클릭으로 끝내기, 다시 눌러 되돌리기 ──

check_span("t-milk").click()
wait_for(lambda: (item_now("t-milk") or {}).get("status") == "done", "t-milk 끝냄 저장")
assert item_now("t-milk")["done_on"] == TODAY.isoformat(), item_now("t-milk")
expect(row("t-milk").locator(".ks-tree-name")).to_have_class(re.compile("is-checked"))
check_span("t-milk").click()
wait_for(lambda: (item_now("t-milk") or {}).get("status") == "open", "t-milk 되돌림 저장")
assert item_now("t-milk")["done_on"] is None, item_now("t-milk")
expect(row("t-milk").locator(".ks-tree-name")).not_to_have_class(re.compile("is-checked"))
results["check_toggle"] = "ok"

# ── 3. 마지막 남은 자식을 끝내면 부모도 끝남 ──

check_span("t-draft").click()
wait_for(lambda: (item_now("t-draft") or {}).get("status") == "done", "t-draft 끝냄 저장")
wait_for(lambda: (item_now("t-report") or {}).get("status") == "done", "부모 t-report 끝냄 저장")
assert item_now("t-report")["done_on"] == TODAY.isoformat(), item_now("t-report")
expect(row("t-report").locator(".ks-tree-name")).to_have_class(re.compile("is-checked"))
results["parent_auto_done"] = "ok"

# ── 4. 구역 + → 대화상자 → 추가 → 새 항목이 고른 상태 ──

section("업무").locator('button[aria-label="할 일 추가"]').click()
dlg = page.locator('[role="dialog"]')
expect(dlg).to_be_visible(timeout=10000)
expect(dlg).to_contain_text("할 일 추가")
dlg.get_by_role("button", name="추가", exact=True).click()
time.sleep(0.6)
expect(dlg).to_be_visible()  # 빈 제목이면 닫히지 않는다
dlg.get_by_label("제목", exact=True).fill("창고 정리")
time.sleep(0.5)
sb.shot("add-dialog.png", "todo", settle=0.2)
dlg.get_by_role("button", name="추가", exact=True).click()
expect(dlg).to_be_hidden(timeout=10000)
added = wait_for(lambda: next((it for it in items_now() if it.get("title") == "창고 정리"), None), "새 항목 저장")
assert added["area"] == "업무" and added["parent"] is None, added
assert added["status"] == "open" and added["date"] is None, added
assert added["order"] == 6, added
expect(row(added["id"])).to_be_visible()
expect(row(added["id"])).to_have_attribute("aria-selected", "true")
expect(win.get_by_label("제목", exact=True)).to_have_value("창고 정리")
results["add_from_section"] = "ok"

# ── 5. 상세에서 제목 고치기(0.5초 뒤 저장), 묶음 바꾸기(구역 이동) ──

row("t-slides").click()
title_input = win.get_by_label("제목", exact=True)
expect(title_input).to_have_value("발표 자료 만들기", timeout=10000)
title_input.fill("발표 자료 다듬기")
title_input.press("Tab")
wait_for(lambda: (item_now("t-slides") or {}).get("title") == "발표 자료 다듬기", "제목 저장", timeout=10)
expect(row("t-slides").locator(".ks-tree-name")).to_have_text("발표 자료 다듬기")

win.locator('button.ks-select-button[aria-label="묶음"]').click()
page.get_by_role("menuitem", name="개인", exact=True).click()
wait_for(lambda: (item_now("t-slides") or {}).get("area") == "개인", "묶음 저장", timeout=10)
moved = item_now("t-slides")
assert moved["parent"] is None and moved["order"] == 2, moved
expect(section("개인").locator('button[data-tree-id="item:t-slides"]')).to_be_visible(timeout=10000)
expect(win.locator('button.ks-select-button[aria-label="묶음"]')).to_contain_text("개인")
results["edit_title_and_area"] = "ok"

# ── 6. 보류 단추 → 배지, 지우기 → 확인 → 사라짐 ──

win.get_by_role("button", name="보류", exact=True).click()
wait_for(lambda: (item_now("t-slides") or {}).get("status") == "held", "보류 저장")
expect(row("t-slides").locator(".ks-badge")).to_have_text("보류")

win.get_by_role("button", name="지우기", exact=True).click()
confirm = page.locator('[role="dialog"]')
expect(confirm).to_be_visible(timeout=10000)
expect(confirm).to_contain_text("할 일을 지울까요?")
expect(confirm).to_contain_text("발표 자료 다듬기")
confirm.get_by_role("button", name="지우기", exact=True).click()
expect(confirm).to_be_hidden(timeout=10000)
wait_for(lambda: item_now("t-slides") is None, "항목 삭제 저장")
expect(row("t-slides")).to_have_count(0)
expect(win.get_by_text("할 일을 고르면 여기에 보입니다")).to_be_visible(timeout=10000)
results["hold_and_remove"] = "ok"

# ── 7. 기록 보기 → 날짜별 묶음, 체크 해제로 되돌리면 할 일 보기에 다시 나타남 ──

win.get_by_role("button", name="기록", exact=True).click()
wait_for(lambda: day_groups().count() >= 2, "기록 보기 다시 열기")
check_span("t-eggs").click()
wait_for(lambda: (item_now("t-eggs") or {}).get("status") == "open", "기록 보기에서 되돌림 저장")
assert item_now("t-eggs")["done_on"] is None
win.get_by_role("button", name="할 일", exact=True).click()
expect(row("t-eggs")).to_be_visible(timeout=10000)
expect(row("t-eggs").locator(".ks-tree-name")).not_to_have_class(re.compile("is-checked"))
results["log_uncheck"] = "ok"

# ── 8. 창이 열린 채 바깥에서 항목 추가 → 화면에 나타남 ──

current = read_storage("items")
root_orders = [it["order"] for it in current["content"] if it["area"] == "업무" and it["parent"] is None]
external = {
    "id": "t-keys",
    "title": "창고 열쇠 반납",
    "area": "업무",
    "parent": None,
    "status": "open",
    "date": None,
    "wait": None,
    "done_on": None,
    "created_on": TODAY.isoformat(),
    "order": max(root_orders) + 1,
}
call("write_app_storage", {"app_id": "todo", "entry_id": "items",
                           "content": current["content"] + [external],
                           "expected_revision": current["revision"]})
expect(row("t-keys")).to_be_visible(timeout=15000)
expect(section("업무").locator('button[data-tree-id="item:t-keys"]')).to_be_visible()
results["external_write"] = "ok"

# ── 행 메뉴: 하위 할 일 추가 → 대화상자 → 취소 ──

row("t-soap").click(button="right")
menu = page.get_by_role("menu")
expect(menu).to_be_visible(timeout=10000)
for label in ("하위 할 일 추가", "보류", "지우기"):
    expect(menu.get_by_role("menuitem", name=label, exact=True)).to_be_visible()
menu.get_by_role("menuitem", name="하위 할 일 추가", exact=True).click()
child_dlg = page.locator('[role="dialog"]')
expect(child_dlg).to_be_visible(timeout=10000)
expect(child_dlg).to_contain_text("할 일 추가")
child_dlg.get_by_role("button", name="취소", exact=True).click()
expect(child_dlg).to_be_hidden(timeout=10000)
results["item_menu"] = "ok"

# ── 9. 불러오는 중 화면: 저장소 읽기가 즉시 끝나 캡처하지 못했다. ──
results["loading"] = "저장소 읽기가 즉시 끝나 불러오는 중 화면을 찍지 못했다"

# ── 10. 좁은 창에서 끝까지 내리면 결정 줄(지우기, 보류)이 보인다 ──

set_size(380, 700)
row("t-keys").click()
expect(win.get_by_label("제목", exact=True)).to_have_value("창고 열쇠 반납", timeout=10000)
win.evaluate("""() => {
  const root = document.querySelector('[data-testid="app-window-todo"]');
  const scrollers = [...root.querySelectorAll('*')].filter((el) => {
    const style = getComputedStyle(el);
    return el.scrollHeight > el.clientHeight + 2 && /(auto|scroll)/.test(style.overflowY);
  });
  scrollers.forEach((el) => { el.scrollTop = el.scrollHeight; });
  return scrollers.length;
}""")
time.sleep(0.5)
box = window_box()
for name in ("지우기", "보류"):
    button = win.get_by_role("button", name=name, exact=True)
    expect(button).to_be_visible(timeout=10000)
    b = button.bounding_box()
    assert b is not None, f"{name} 좌표 없음"
    inside = (b["x"] >= box["x"] - 1 and b["y"] >= box["y"] - 1
              and b["x"] + b["width"] <= box["x"] + box["width"] + 1
              and b["y"] + b["height"] <= box["y"] + box["height"] + 1)
    assert inside, f"{name}가 창 밖입니다: 버튼 {b}, 창 {box}"
sb.shot("narrow-bottom.png", "todo", settle=0.3)
results["narrow_bottom_row"] = "ok"

set_size(1040, 700)
results["window_size"] = {"width": definition["window_size"]["width"], "height": definition["window_size"]["height"]}
results["today"] = TODAY.isoformat()
(OUT / "todo-scenario.json").write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
log("확인 끝", json.dumps(results, ensure_ascii=False))
