/*
 * 할 일 — kaleidoscope 클라이언트 (todo-client v1)
 *
 * 저장소 두 곳을 다룬다.
 *   items: 할 일 항목 배열 (앱과 바깥 도구가 함께 고치는 계약)
 *   areas: 묶음 이름과 순서 (쉘의 앱 설정 화면이 그린다)
 *
 * 화면에 그릴 값은 전부 publish로 내보내고, 블록은 그 값을 그리기만 한다.
 * 쓰기는 한 줄로 세워 보내고, revision 충돌이면 다시 읽어 같은 연산을 한 번 더 적용한다.
 *
 * 계산(날짜 표기, 트리 만들기, 위아래 전파)은 연결 코드와 나눠 두어 시험에서 그대로 부를 수 있게 한다.
 */
(function () {
  "use strict";

  var bridge = window.kaleidoscope;
  if (!bridge) return;

  var EDIT_DELAY_MS = 500;
  var CLOSE_LIMIT_MS = 4000;
  var CONFLICT_ID = "STORAGE_ITEM_WRITE_CONFLICT";
  var DAY_PREFIX = "day:";
  var WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];
  var DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

  function pad2(value) { return value < 10 ? "0" + value : String(value); }

  function isObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }

  function textOf(value) { return typeof value === "string" ? value : ""; }

  // 기기 시간대의 오늘. 저장소와 화면의 날짜는 모두 이 기준이다.
  function todayString() {
    var now = new Date();
    return now.getFullYear() + "-" + pad2(now.getMonth() + 1) + "-" + pad2(now.getDate());
  }

  function parseDay(day) {
    if (typeof day !== "string") return null;
    var match = DATE_PATTERN.exec(day);
    if (!match) return null;
    var date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12, 0, 0, 0);
    if (date.getFullYear() !== Number(match[1]) || date.getMonth() !== Number(match[2]) - 1 || date.getDate() !== Number(match[3])) return null;
    return date;
  }

  function shiftDay(day, delta) {
    var date = parseDay(day);
    if (!date) return null;
    date.setDate(date.getDate() + delta);
    return date.getFullYear() + "-" + pad2(date.getMonth() + 1) + "-" + pad2(date.getDate());
  }

  /** 항목 날짜 표기: 오늘·내일·어제, 올해는 M/D, 다른 해는 YYYY/M/D. */
  function dayLabel(day, today) {
    if (!day) return null;
    if (day === today) return "오늘";
    if (day === shiftDay(today, 1)) return "내일";
    if (day === shiftDay(today, -1)) return "어제";
    var parts = day.split("-");
    var year = Number(parts[0]);
    var month = Number(parts[1]);
    var date = Number(parts[2]);
    if (String(year) === today.slice(0, 4)) return month + "/" + date;
    return year + "/" + month + "/" + date;
  }

  /** 기록 보기의 날짜 행 제목: 오늘·어제, 그 밖에는 「11월 9일 (월)」. */
  function dayRowLabel(day, today) {
    if (day === today) return "오늘";
    if (day === shiftDay(today, -1)) return "어제";
    var date = parseDay(day);
    if (!date) return day;
    return (date.getMonth() + 1) + "월 " + date.getDate() + "일 (" + WEEKDAYS[date.getDay()] + ")";
  }

  function numbersOf(value) {
    return typeof value === "number" && isFinite(value) ? value : 0;
  }

  function asItems(value) {
    return Array.isArray(value) ? value.filter(isObject) : [];
  }

  function asAreas(value) {
    return Array.isArray(value) ? value.filter(function (entry) { return typeof entry === "string" && entry !== ""; }) : [];
  }

  // 항목을 고쳐 쓸 때는 객체를 펼쳐 복사한다(앱이 모르는 바깥 필드도 보존).
  function copyItem(item) {
    return Object.assign({}, item);
  }

  function itemOf(items, id) {
    for (var index = 0; index < items.length; index += 1) if (items[index].id === id) return items[index];
    return null;
  }

  function childMap(items) {
    var map = {};
    items.forEach(function (item) {
      if (typeof item.id !== "string" || typeof item.parent !== "string") return;
      if (!map[item.parent]) map[item.parent] = [];
      map[item.parent].push(item);
    });
    Object.keys(map).forEach(function (key) {
      map[key].sort(function (left, right) { return numbersOf(left.order) - numbersOf(right.order); });
    });
    return map;
  }

  function indexItems(items) {
    var byId = {};
    items.forEach(function (item) { if (typeof item.id === "string") byId[item.id] = item; });
    return byId;
  }

  /** done이면 done_on이 오늘이나 어제여야 보인다. open·held는 늘 보인다. */
  function isActive(item, today) {
    if (item.status === "done") return item.done_on === today || item.done_on === shiftDay(today, -1);
    return item.status === "open" || item.status === "held";
  }

  function visibleIds(items, today) {
    var byId = indexItems(items);
    var visible = {};
    var queue = [];
    items.forEach(function (item) {
      if (typeof item.id === "string" && isActive(item, today)) {
        visible[item.id] = true;
        queue.push(item.id);
      }
    });
    // 조건에 맞는 자손이 있는 조상도 함께 보인다.
    while (queue.length) {
      var item = byId[queue.pop()];
      var parent = item && typeof item.parent === "string" ? byId[item.parent] : null;
      if (parent && typeof parent.id === "string" && !visible[parent.id]) {
        visible[parent.id] = true;
        queue.push(parent.id);
      }
    }
    return { ids: visible, byId: byId };
  }

  function itemMeta(item, today) {
    if (item.status === "done") return dayLabel(typeof item.done_on === "string" ? item.done_on : null, today);
    var parts = [];
    var dateLabel = dayLabel(typeof item.date === "string" && item.date ? item.date : null, today);
    if (dateLabel) parts.push(dateLabel);
    var wait = textOf(item.wait).trim();
    if (wait) parts.push(wait);
    return parts.length ? parts.join(" · ") : null;
  }

  function treeNode(item, children, today) {
    var node = { key: item.id, title: textOf(item.title), checked: item.status === "done" };
    var meta = itemMeta(item, today);
    if (meta !== null) node.meta = meta;
    if (item.status === "held") node.badges = ["보류"];
    if (children.length) node.children = children;
    return node;
  }

  /** 묶음 순서: 설정 순서, 설정에 없는 이름은 보이는 항목이 처음 나온 순서대로 뒤에. */
  function sectionNames(items, areas, visible) {
    var seen = {};
    var names = [];
    areas.forEach(function (name) {
      if (seen[name]) return;
      seen[name] = true;
      names.push(name);
    });
    items.forEach(function (item) {
      var area = textOf(item.area);
      if (!area || seen[area] || typeof item.id !== "string" || !visible.ids[item.id]) return;
      seen[area] = true;
      names.push(area);
    });
    return names;
  }

  function buildSections(items, areas, today) {
    var visible = visibleIds(items, today);
    var children = childMap(items);
    var areaOf = function (item) { return textOf(item.area); };
    var nodesFor = function (parentId, area) {
      var list = parentId === null ? items.filter(function (item) { return !item.parent; }) : (children[parentId] || []);
      return list
        .filter(function (item) { return visible.ids[item.id] && areaOf(item) === area; })
        .sort(function (left, right) { return numbersOf(left.order) - numbersOf(right.order); })
        .map(function (item) { return treeNode(item, nodesFor(item.id, area), today); });
    };
    return sectionNames(items, areas, visible).map(function (area) {
      return { key: area, name: area, children: nodesFor(null, area) };
    });
  }

  function areaOptionList(items, areas) {
    var seen = {};
    var options = [];
    var push = function (name) {
      if (!name || seen[name]) return;
      seen[name] = true;
      options.push(name);
    };
    areas.forEach(push);
    items.forEach(function (item) { push(textOf(item.area)); });
    return options;
  }

  function areaRank(areas) {
    var rank = {};
    areas.forEach(function (name, index) { if (!(name in rank)) rank[name] = index; });
    return rank;
  }

  function buildLog(items, areas, today) {
    var rank = areaRank(areaOptionList(items, areas));
    var groups = {};
    items.forEach(function (item) {
      if (item.status !== "done" || typeof item.done_on !== "string") return;
      if (!parseDay(item.done_on)) return;
      if (!groups[item.done_on]) groups[item.done_on] = [];
      groups[item.done_on].push(item);
    });
    var byId = indexItems(items);
    return Object.keys(groups).sort().reverse().map(function (day) {
      var entries = groups[day].slice().sort(function (left, right) {
        var areaLeft = rank[textOf(left.area)];
        var areaRight = rank[textOf(right.area)];
        var order = numbersOf(areaLeft === undefined ? Number.MAX_SAFE_INTEGER : areaLeft) - numbersOf(areaRight === undefined ? Number.MAX_SAFE_INTEGER : areaRight);
        if (order !== 0) return order;
        return numbersOf(left.order) - numbersOf(right.order);
      });
      return {
        key: DAY_PREFIX + day,
        title: dayRowLabel(day, today),
        children: entries.map(function (item) {
          var parent = typeof item.parent === "string" ? byId[item.parent] : null;
          var meta = textOf(item.area);
          if (parent) meta += " · " + textOf(parent.title);
          return { key: item.id, title: textOf(item.title), checked: true, meta: meta };
        }),
      };
    });
  }

  // ── 연산: 지금 가진 최신 items에 적용한 새 배열을 만든다. null이면 바꿀 것이 없다. ──

  function descendantsOf(items, id) {
    var result = [];
    var seen = {};
    seen[id] = true;
    var queue = [id];
    while (queue.length) {
      var current = queue.shift();
      items.forEach(function (item) {
        if (item.parent !== current || seen[item.id]) return;
        seen[item.id] = true;
        result.push(item);
        queue.push(item.id);
      });
    }
    return result;
  }

  function allDone(list) {
    return list.length > 0 && list.every(function (item) { return item.status === "done"; });
  }

  function applyCheck(items, op) {
    var target = itemOf(items, op.id);
    if (!target) return null;
    var next = items.map(copyItem);
    var changed = itemOf(next, op.id);
    if (op.checked) {
      changed.status = "done";
      changed.done_on = op.today;
      descendantsOf(next, op.id).forEach(function (item) {
        if (item.status === "open" || item.status === "held") {
          item.status = "done";
          item.done_on = op.today;
        }
      });
      // 자식이 모두 끝난 조상도 같은 날 끝낸다. 끝나지 않은 자식이 나오면 거기서 멈춘다.
      var seen = {};
      seen[op.id] = true;
      var parentId = typeof changed.parent === "string" ? changed.parent : null;
      while (parentId && !seen[parentId]) {
        seen[parentId] = true;
        var parent = itemOf(next, parentId);
        if (!parent) break;
        var siblings = next.filter(function (item) { return item.parent === parent.id; });
        if (!allDone(siblings)) break;
        parent.status = "done";
        parent.done_on = op.today;
        parentId = typeof parent.parent === "string" ? parent.parent : null;
      }
    } else {
      changed.status = "open";
      changed.done_on = null;
      var seenUp = {};
      seenUp[op.id] = true;
      var upId = typeof changed.parent === "string" ? changed.parent : null;
      while (upId && !seenUp[upId]) {
        seenUp[upId] = true;
        var ancestor = itemOf(next, upId);
        if (!ancestor || ancestor.status !== "done") break;
        ancestor.status = "open";
        ancestor.done_on = null;
        upId = typeof ancestor.parent === "string" ? ancestor.parent : null;
      }
    }
    return next;
  }

  function applyAdd(items, op) {
    var piece = Object.assign({}, op.item);
    var siblings = typeof piece.parent === "string"
      ? items.filter(function (item) { return item.parent === piece.parent; })
      : items.filter(function (item) { return !item.parent && textOf(item.area) === textOf(piece.area); });
    piece.order = maxOrder(siblings) + 1;
    var next = items.map(copyItem);
    next.push(piece);
    // 끝난 부모와 끝난 조상을 다시 연다.
    var seen = {};
    seen[piece.id] = true;
    var parentId = typeof piece.parent === "string" ? piece.parent : null;
    while (parentId && !seen[parentId]) {
      seen[parentId] = true;
      var parent = itemOf(next, parentId);
      if (!parent || parent.status !== "done") break;
      parent.status = "open";
      parent.done_on = null;
      parentId = typeof parent.parent === "string" ? parent.parent : null;
    }
    return next;
  }

  function maxOrder(items) {
    var max = -1;
    items.forEach(function (item) { max = Math.max(max, numbersOf(item.order)); });
    return max;
  }

  function applyEdit(items, op) {
    var target = itemOf(items, op.id);
    if (!target) return null;
    if (op.field === "title") {
      if (!textOf(op.value).trim() || op.value === target.title) return null;
      return items.map(function (item) {
        if (item.id !== op.id) return item;
        var copy = copyItem(item);
        copy.title = op.value;
        return copy;
      });
    }
    if (op.field === "wait") {
      var wait = textOf(op.value).trim() ? op.value : null;
      if ((target.wait === undefined ? null : target.wait) === wait) return null;
      return items.map(function (item) {
        if (item.id !== op.id) return item;
        var copy = copyItem(item);
        copy.wait = wait;
        return copy;
      });
    }
    if (op.field === "date") {
      var date = typeof op.value === "string" && DATE_PATTERN.test(op.value) ? op.value : null;
      if ((target.date === undefined ? null : target.date) === date) return null;
      return items.map(function (item) {
        if (item.id !== op.id) return item;
        var copy = copyItem(item);
        copy.date = date;
        return copy;
      });
    }
    if (op.field === "area") {
      var area = textOf(op.value);
      if (!area || area === textOf(target.area)) return null;
      var moving = {};
      moving[op.id] = true;
      descendantsOf(items, op.id).forEach(function (item) { moving[item.id] = true; });
      var roots = items.filter(function (item) { return !item.parent && textOf(item.area) === area && !moving[item.id]; });
      var order = maxOrder(roots) + 1;
      return items.map(function (item) {
        if (!moving[item.id]) return item;
        var copy = copyItem(item);
        copy.area = area;
        if (item.id === op.id) {
          copy.parent = null;
          copy.order = order;
        }
        return copy;
      });
    }
    return null;
  }

  function applyToggleHold(items, op) {
    var target = itemOf(items, op.id);
    if (!target) return null;
    return items.map(function (item) {
      if (item.id !== op.id) return item;
      var copy = copyItem(item);
      copy.status = item.status === "held" ? "open" : "held";
      copy.done_on = null;
      return copy;
    });
  }

  function applyRemove(items, op) {
    if (!itemOf(items, op.id)) return null;
    var removing = {};
    removing[op.id] = true;
    descendantsOf(items, op.id).forEach(function (item) { removing[item.id] = true; });
    return items.filter(function (item) { return !removing[item.id]; });
  }

  function applyOp(items, op) {
    switch (op.kind) {
      case "check": return applyCheck(items, op);
      case "add": return applyAdd(items, op);
      case "edit": return applyEdit(items, op);
      case "hold": return applyToggleHold(items, op);
      case "remove": return applyRemove(items, op);
      default: return null;
    }
  }

  // ── 연결: 창 상태, 저장소, 화면 출력 ──

  var state = { items: [], areas: [], selected: null, view: "open", loaded: false };
  var today = todayString();
  var draft = { title: "", date: null };
  var pendingEdits = { title: null, wait: null };
  var writeQueue = Promise.resolve();
  var midnightTimer = null;

  function initialValue(name) {
    var value = bridge.getState(name);
    return value === undefined ? null : value;
  }

  (function readInitialState() {
    var selected = initialValue("selected");
    var view = initialValue("view");
    if (typeof selected === "string") state.selected = selected;
    if (typeof view === "string" && view) state.view = view;
  })();

  function selectedItem() {
    var id = state.selected;
    if (typeof id !== "string" || id === "" || id.indexOf(DAY_PREFIX) === 0) return null;
    return itemOf(state.items, id);
  }

  function publish() {
    var item = selectedItem();
    bridge.publish({
      loading: !state.loaded,
      open_view: state.loaded && state.view !== "log",
      log_view: state.loaded && state.view === "log",
      sections: state.loaded ? buildSections(state.items, state.areas, today) : [],
      log: state.loaded ? buildLog(state.items, state.areas, today) : [],
      area_options: state.loaded ? areaOptionList(state.items, state.areas) : [],
      has_selection: state.loaded && item !== null,
      show_hint: state.loaded && item === null,
      d_title: item ? textOf(item.title) : null,
      d_area: item ? textOf(item.area) : null,
      d_date: item && typeof item.date === "string" && item.date ? item.date : null,
      d_wait: item && typeof item.wait === "string" && item.wait ? item.wait : null,
      held: item !== null && item.status === "held",
      selected_title: item ? textOf(item.title) : null,
      add_title: draft.title,
      add_date: draft.date,
    });
  }

  /** 고른 항목이 사라졌으면 선택을 비운다. 기록 보기의 날짜 행 선택은 그대로 둔다. */
  function ensureSelection() {
    var id = state.selected;
    if (typeof id !== "string" || id === "" || id.indexOf(DAY_PREFIX) === 0) return;
    if (itemOf(state.items, id)) return;
    state.selected = null;
    bridge.setState("selected", null);
  }

  bridge.onStateChange(function (next) {
    if (!isObject(next)) return;
    var selected = typeof next.selected === "string" ? next.selected : null;
    var view = typeof next.view === "string" && next.view ? next.view : "open";
    if (selected === state.selected && view === state.view) return;
    state.selected = selected;
    state.view = view;
    publish();
  });

  bridge.onStorageChange("items", function (value) {
    state.items = asItems(value);
    ensureSelection();
    publish();
  });
  bridge.onStorageChange("areas", function (value) {
    state.areas = asAreas(value);
    publish();
  });

  function refreshToday() {
    var next = todayString();
    if (next !== today) {
      today = next;
      publish();
    }
    scheduleMidnight();
  }

  function scheduleMidnight() {
    if (midnightTimer) clearTimeout(midnightTimer);
    var now = new Date();
    var midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 50);
    midnightTimer = setTimeout(function () {
      midnightTimer = null;
      refreshToday();
    }, Math.max(1000, midnight.getTime() - now.getTime()));
  }

  function fail(error) {
    bridge.notice(error && typeof error.message === "string" ? error.message : String(error));
  }

  function enqueue(op) {
    var task = writeQueue.then(function () { return attempt(op, false); }, function () { return attempt(op, false); });
    writeQueue = task.then(function () {}, function () {});
    return task;
  }

  function attempt(op, retried) {
    var next = applyOp(state.items, op);
    if (next === null) return Promise.resolve();
    return bridge.setStorage("items", next).then(function () {
      state.items = asItems(next);
      ensureSelection();
      publish();
      afterCommit(op);
    }, function (error) {
      if (!retried && error && error.id === CONFLICT_ID) {
        return bridge.getStorage("items").then(function (value) {
          state.items = asItems(value);
          return attempt(op, true);
        });
      }
      throw error;
    });
  }

  function afterCommit(op) {
    if (op.kind !== "add") return;
    draft = { title: "", date: null };
    state.selected = op.id;
    bridge.setState({ adding: null, selected: op.id });
    publish();
  }

  function newId() {
    var random = "";
    while (random.length < 4) random += Math.floor(Math.random() * 36).toString(36);
    return "t" + Date.now().toString(36) + random;
  }

  // ── 동작 ──

  function targetId(context) {
    var item = context && isObject(context.item) ? context.item : null;
    if (item && typeof item.key === "string" && item.key) return item.key;
    var id = state.selected;
    return typeof id === "string" && id && id.indexOf(DAY_PREFIX) !== 0 ? id : null;
  }

  function scheduleEdit(field, id, value) {
    var previous = pendingEdits[field];
    if (previous && previous.timer) clearTimeout(previous.timer);
    var entry = { id: id, value: value, timer: null };
    entry.timer = setTimeout(function () {
      entry.timer = null;
      if (pendingEdits[field] === entry) pendingEdits[field] = null;
      enqueue({ kind: "edit", id: entry.id, field: field, value: entry.value }).catch(fail);
    }, EDIT_DELAY_MS);
    pendingEdits[field] = entry;
  }

  function cancelPending(field) {
    var pending = pendingEdits[field];
    if (!pending) return;
    if (pending.timer) clearTimeout(pending.timer);
    pendingEdits[field] = null;
  }

  function flushEdits() {
    var tasks = [];
    ["title", "wait"].forEach(function (field) {
      var pending = pendingEdits[field];
      if (!pending) return;
      if (pending.timer) clearTimeout(pending.timer);
      pendingEdits[field] = null;
      tasks.push(enqueue({ kind: "edit", id: pending.id, field: field, value: pending.value }));
    });
    return tasks;
  }

  function withLimit(promise) {
    return new Promise(function (resolve) {
      var done = false;
      var finish = function () {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve();
      };
      var timer = setTimeout(finish, CLOSE_LIMIT_MS);
      promise.then(finish, finish);
    });
  }

  bridge.onLifecycle(function (lifecycle) {
    if (!isObject(lifecycle)) return;
    if (lifecycle.phase === "closing") {
      return withLimit(Promise.all(flushEdits().map(function (task) { return task.catch(function () {}); })));
    }
    if (lifecycle.visible) refreshToday();
  });

  function openDialog(area, parent) {
    draft = { title: "", date: null };
    bridge.setState({ adding: { area: area, parent: parent } });
    publish();
  }

  bridge.handle("check", function (context) {
    var item = context && isObject(context.item) ? context.item : null;
    var id = item && typeof item.key === "string" ? item.key : "";
    if (!id || id.indexOf(DAY_PREFIX) === 0) return;
    return enqueue({ kind: "check", id: id, checked: context.event === true, today: todayString() });
  });

  bridge.handle("add", function () {
    var adding = bridge.getState("adding");
    if (!isObject(adding)) return;
    var title = draft.title.trim();
    if (!title) return;
    var area = textOf(adding.area);
    if (!area) {
      area = state.areas.length ? state.areas[0] : "";
    }
    if (!area) return;
    var parent = typeof adding.parent === "string" && adding.parent ? adding.parent : null;
    var id = newId();
    return enqueue({
      kind: "add",
      id: id,
      item: {
        id: id,
        title: draft.title,
        area: area,
        parent: parent,
        status: "open",
        date: draft.date,
        wait: null,
        done_on: null,
        created_on: todayString(),
        order: 0,
      },
    });
  });

  bridge.handle("edit", function (context) {
    var field = context && typeof context.args === "string" ? context.args : "";
    var item = selectedItem();
    if (!item) return;
    if (field === "title") {
      var title = textOf(context.event);
      if (!title.trim()) { cancelPending("title"); return; }
      scheduleEdit("title", item.id, title);
      return;
    }
    if (field === "wait") {
      var wait = textOf(context.event);
      var current = typeof item.wait === "string" ? item.wait : "";
      if (wait.trim() === current.trim()) { cancelPending("wait"); return; }
      scheduleEdit("wait", item.id, wait);
      return;
    }
    if (field === "date") {
      return enqueue({ kind: "edit", id: item.id, field: "date", value: textOf(context.event) });
    }
    if (field === "area") {
      return enqueue({ kind: "edit", id: item.id, field: "area", value: textOf(context.event) });
    }
  });

  bridge.handle("toggle_hold", function (context) {
    var id = targetId(context);
    if (!id) return;
    return enqueue({ kind: "hold", id: id });
  });

  bridge.handle("remove", function (context) {
    var id = targetId(context);
    if (!id) return;
    return enqueue({ kind: "remove", id: id });
  });

  bridge.handle("open_add_area", function (context) {
    var item = context && isObject(context.item) ? context.item : null;
    var area = item && typeof item.key === "string" ? item.key : "";
    if (!area && state.areas.length) area = state.areas[0];
    if (!area) return;
    openDialog(area, null);
  });

  bridge.handle("open_add_child", function (context) {
    var item = context && isObject(context.item) ? context.item : null;
    var id = item && typeof item.key === "string" ? item.key : "";
    var target = id ? itemOf(state.items, id) : null;
    if (!target) return;
    openDialog(textOf(target.area), target.id);
  });

  bridge.handle("dialog_title", function (context) {
    draft.title = textOf(context.event);
    publish();
  });

  bridge.handle("dialog_date", function (context) {
    var value = textOf(context.event);
    draft.date = DATE_PATTERN.test(value) ? value : null;
    publish();
  });

  bridge.handle("dialog_close", function () {
    draft = { title: "", date: null };
    bridge.setState("adding", null);
    publish();
  });

  // ── 시작: 저장소를 읽고 화면을 그린다 ──

  publish();
  bridge.getStorage("items").then(function (items) {
    state.items = asItems(items);
    return bridge.getStorage("areas");
  }).then(function (areas) {
    state.areas = asAreas(areas);
    state.loaded = true;
    ensureSelection();
    scheduleMidnight();
    publish();
  }).catch(function (error) {
    state.loaded = true;
    scheduleMidnight();
    publish();
    fail(error);
  });
})();
