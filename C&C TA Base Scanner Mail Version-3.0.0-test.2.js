// ==UserScript==
// @name         C&C TA Base Scanner Mail Version
// @namespace    https://github.com/mogsy52/cnc
// @version      3.0.0-test.2
// @description  Scans nearby Forgotten camps, outposts and bases, filters useful layouts and mails the results.
// @author       EHz; modernised for mogsy52
// @match        https://*.alliances.commandandconquer.com/*/index.aspx*
// @match        http://*.alliances.commandandconquer.com/*/index.aspx*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
  "use strict";

  // ClientLib and Qooxdoo live in the page context, which is not directly
  // visible from every userscript manager's sandbox.
  const pageMain = function () {
    "use strict";

    const SCRIPT = "TA Base Scanner";
    const CONFIG = { maxLoadAttempts: 30, loadRetryMs: 250, mailTextLimit: 2300, mailDelayMs: 850 };
    const STORAGE_KEY = "ta-base-scanner-filters-v3";
    const state = {
      running: false, abort: false, button: null, dialog: null,
      originalCityId: null, filters: null, queue: [], queueIndex: 0,
      seen: new Set(), results: [], failures: [], analysed: 0,
      rejectedGhost: 0, rejectedNotNpc: 0, resourceTypes: new Set(), sourceCityCount: 0,
      activeSourceCityId: null, npcValues: new Set(), mismatchedCityIds: 0
    };

    function log(...args) { console.log(`[${SCRIPT}]`, ...args); }
    function fail(message) { throw new Error(message); }
    function delay(ms) { return new Promise(resolve => window.setTimeout(resolve, ms)); }
    function showError(error) {
      const message = String(error && error.message ? error.message : error);
      console.error(`[${SCRIPT}]`, error);
      try { qx.core.Init.getApplication().showError(message); }
      catch (_) { window.alert(`${SCRIPT}: ${message}`); }
    }
    function setButton(label, enabled) {
      if (!state.button || state.button.isDisposed()) return;
      state.button.setLabel(label);
      state.button.setEnabled(enabled !== false);
    }
    function callFirst(object, methodNames) {
      for (const name of methodNames) {
        try {
          if (object && typeof object[name] === "function") {
            const value = object[name]();
            if (value !== undefined && value !== null) return value;
          }
        } catch (_) {}
      }
      return null;
    }
    function cityId(city) { return callFirst(city, ["get_Id", "get_ID", "getId"]); }
    function worldObjectId(object) { return callFirst(object, ["get_Id", "get_ID", "getId", "getID"]); }
    function wrappedField(getter) {
      if (typeof getter !== "function") return null;
      // Region getters normally proxy a value held by their WorldObject:
      // return this.<worldObject>.<field>. Field names may now be any length.
      const match = getter.toString().match(/return\s+this\.[A-Za-z_$][\w$]*\.([A-Za-z_$][\w$]*)/);
      return match ? match[1] : null;
    }
    function installWorldObjectAccessors() {
      const worldSector = ClientLib.Data.WorldSector;
      const region = ClientLib.Vis && ClientLib.Vis.Region;
      if (!worldSector || !region) return;
      for (const kind of ["City", "NPCBase", "NPCCamp"]) {
        const WorldClass = worldSector[`WorldObject${kind}`];
        const RegionClass = region[`Region${kind}`];
        if (!WorldClass || !RegionClass) continue;
        const worldProto = WorldClass.prototype;
        const regionProto = RegionClass.prototype;
        if (typeof worldProto.get_Id !== "function" && typeof worldProto.getID !== "function") {
          const idField = wrappedField(regionProto.get_Id);
          if (idField) {
            worldProto.get_Id = function () { return this[idField]; };
            log(`Installed current ${kind} ID accessor (${idField}).`);
          }
        }
        if (kind === "NPCCamp" && typeof worldProto.get_CampType !== "function") {
          const campField = wrappedField(regionProto.get_CampType);
          if (campField) worldProto.get_CampType = function () { return this[campField]; };
        }
      }
    }
    function valuesFromCollection(collection) {
      if (!collection) return [];
      if (Array.isArray(collection)) return collection;
      for (const key of ["d", "l"]) {
        if (collection[key] && typeof collection[key] === "object") {
          return Array.isArray(collection[key]) ? collection[key] : Object.values(collection[key]);
        }
      }
      return typeof collection === "object"
        ? Object.values(collection).filter(value => value && typeof value === "object") : [];
    }
    function ownCities() {
      const cities = ClientLib.Data.MainData.GetInstance().get_Cities();
      return valuesFromCollection(cities.get_AllCities()).filter(city =>
        city && typeof city.get_PosX === "function" && typeof city.get_PosY === "function");
    }
    function isForgottenObject(object) {
      if (!object) return false;
      const types = ClientLib.Data.WorldSector.ObjectType;
      return object.Type === types.NPCBase || object.Type === types.NPCCamp;
    }
    function isDestroyedCamp(object) {
      const value = callFirst(object, ["get_CampType", "getCampType"]);
      const destroyed = ClientLib.Data.Reports && ClientLib.Data.Reports.ENPCCampType
        ? ClientLib.Data.Reports.ENPCCampType.Destroyed : null;
      return value !== null && destroyed !== null && value === destroyed;
    }
    function isPlayerBase(object) {
      if (!object) return false;
      const types = ClientLib.Data.WorldSector.ObjectType || {};
      for (const key of ["City", "PlayerCity"]) {
        if (types[key] !== undefined && object.Type === types[key]) return true;
      }
      // Compatibility fallback if a client build renames the City enum.
      if (isForgottenObject(object)) return false;
      const ownerId = callFirst(object, ["get_OwnerId", "get_PlayerId", "get_PlayerID"]);
      if (Number(ownerId) > 0) return true;
      const playerName = callFirst(object, ["get_PlayerName", "get_OwnerName"]);
      return typeof playerName === "string" && playerName.length > 0;
    }
    function availabilityAt(x, y) {
      const world = ClientLib.Data.MainData.GetInstance().get_World();
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if ((dx !== 0 || dy !== 0) && isPlayerBase(world.GetObjectFromPosition(x + dx, y + dy))) return false;
        }
      }
      return true;
    }

    function analyseLayout(city, filters) {
      const full = filters.scanMode === "full";
      const needTib = full || filters.tib !== "any";
      const needPower = full || filters.power > 0;
      const counts = { tib: { 4: 0, 5: 0, 6: 0 }, power8: 0 };
      const powerCentres = new Set();
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 9; x++) {
          const centreResource = city.GetResourceType(x, y);
          state.resourceTypes.add(String(centreResource));
          if (centreResource !== 0 || y === 0 || y === 7 || x === 0 || x === 8) continue;
          let tib = 0;
          let empty = 0;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              if (dx === 0 && dy === 0) continue;
              const resource = city.GetResourceType(x + dx, y + dy);
              state.resourceTypes.add(String(resource));
              // ClientLib resource 2 is Tiberium.
              if (needTib && resource === 2) tib++;
              else if (needPower && resource === 0 && !powerCentres.has(`${x + dx},${y + dy}`)) empty++;
            }
          }
          if (needTib && counts.tib[tib] !== undefined) counts.tib[tib]++;
          if (needPower && empty === 8) { counts.power8++; powerCentres.add(`${x},${y}`); }
        }
      }
      return counts;
    }
    function matchesResourceFilters(layout, filters) {
      const tests = [];
      if (filters.tib === "2x4") tests.push(layout.tib[4] >= 2);
      else if (filters.tib === "1x5") tests.push(layout.tib[5] >= 1);
      else if (filters.tib === "1x6") tests.push(layout.tib[6] >= 1);
      if (filters.power > 0) tests.push(layout.power8 >= filters.power);
      if (!tests.length) return true;
      return filters.match === "both" ? tests.every(Boolean) : tests.some(Boolean);
    }
    function matchesAvailability(available, wanted) {
      return wanted === "any" || (wanted === "available" && available) || (wanted === "blocked" && !available);
    }
    function bold(value) { return value > 0 ? `[b]${value}[/b]` : "0"; }
    function formatResult(result) {
      const c = result.layout;
      const details = [];
      if (state.filters.scanMode === "full" || state.filters.tib !== "any") {
        details.push(`tib(4-6): ${[4, 5, 6].map(value => bold(c.tib[value])).join("|")}`);
      }
      if (state.filters.scanMode === "full" || state.filters.power > 0) {
        details.push(`pow(8): ${bold(c.power8)}`);
      }
      return `[coords]${result.x}:${result.y}[/coords] ` +
        `${result.available ? "[b]AVAILABLE[/b]" : "BLOCKED"}` +
        `${details.length ? ` ${details.join(" ")}` : ""}`;
    }
    function filterSummary(filters) {
      const resource = [];
      if (filters.tib === "2x4") resource.push("at least 2 x 4-field Tiberium positions");
      else if (filters.tib === "1x5") resource.push("at least 1 x 5-field Tiberium position");
      else if (filters.tib === "1x6") resource.push("at least 1 x 6-field Tiberium position");
      if (filters.power) resource.push(`${filters.power}+ eight-field power positions`);
      const resourceText = resource.length
        ? resource.join(filters.match === "both" ? " AND " : " OR ") : "all layouts";
      const availability = filters.availability === "available" ? "available now"
        : filters.availability === "blocked" ? "blocked only" : "any availability";
      return `${filters.scanMode === "fast" ? "Fast" : "Full"}; ${resourceText}; ${availability}`;
    }

    function buildQueue() {
      installWorldObjectAccessors();
      const main = ClientLib.Data.MainData.GetInstance();
      const world = main.get_World();
      const maxDistance = Number(main.get_Server().get_MaxAttackDistance());
      const radius = Math.ceil(maxDistance);
      const cities = ownCities();
      if (!cities.length) fail("No owned cities were available to scan from.");
      state.sourceCityCount = cities.length;
      for (const ownCity of cities) {
        const ownX = ownCity.get_PosX();
        const ownY = ownCity.get_PosY();
        for (let y = ownY - radius; y <= ownY + radius; y++) {
          for (let x = ownX - radius; x <= ownX + radius; x++) {
            const dx = ownX - x;
            const dy = ownY - y;
            if (Math.sqrt(dx * dx + dy * dy) >= maxDistance) continue;
            const key = `${x}:${y}`;
            if (state.seen.has(key)) continue;
            const object = world.GetObjectFromPosition(x, y);
            if (!isForgottenObject(object) || isDestroyedCamp(object)) continue;
            const id = worldObjectId(object);
            if (id === null) { state.failures.push(`${key} (no current ID accessor)`); continue; }
            state.seen.add(key);
            state.queue.push({ id, x, y, sourceCityId: cityId(ownCity), attempts: 0 });
          }
        }
      }
      log(`Queued ${state.queue.length} unique Forgotten camps, outposts and bases from ${cities.length} cities.`);
    }
    async function loadCity(item) {
      const cities = ClientLib.Data.MainData.GetInstance().get_Cities();
      cities.set_CurrentCityId(item.id);
      ClientLib.Net.CommunicationManager.GetInstance().UserAction();
      while (item.attempts++ < CONFIG.maxLoadAttempts) {
        const city = cities.GetCity(item.id);
        if (city) {
          try {
            if (typeof city.get_IsGhostMode === "function" && city.get_IsGhostMode()) {
              state.rejectedGhost++;
              return null;
            }
            if (typeof city.IsNPC === "function") {
              // Current builds no longer consistently return the literal
              // Boolean true here. The world-map type was already verified.
              state.npcValues.add(String(city.IsNPC()));
            }
            const loadedCityId = cityId(city);
            if (loadedCityId !== null && String(loadedCityId) !== String(item.id)) {
              state.mismatchedCityIds++;
              return null;
            }
            const loaded = typeof city.GetBuildingsConditionInPercent !== "function" ||
              city.GetBuildingsConditionInPercent() !== 0;
            if (loaded && typeof city.GetResourceType === "function") return city;
          } catch (_) {}
        }
        await delay(CONFIG.loadRetryMs);
      }
      state.failures.push(`${item.x}:${item.y} (layout did not load)`);
      return null;
    }
    async function activateSourceCity(sourceCityId) {
      if (sourceCityId === null || String(state.activeSourceCityId) === String(sourceCityId)) return;
      const source = ownCities().find(city => String(cityId(city)) === String(sourceCityId));
      if (!source) fail(`Unable to activate source city ${sourceCityId}.`);
      const vis = ClientLib.Vis.VisMain.GetInstance();
      vis.CenterGridPosition(source.get_PosX(), source.get_PosY());
      if (typeof vis.Update === "function") vis.Update();
      if (typeof vis.ViewUpdate === "function") vis.ViewUpdate();
      state.activeSourceCityId = sourceCityId;
      // Give the newly activated world region time to populate before asking
      // ClientLib for the first target layout in this source group.
      await delay(350);
    }
    async function scanQueue() {
      for (state.queueIndex = 0; state.queueIndex < state.queue.length; state.queueIndex++) {
        if (state.abort) break;
        const item = state.queue[state.queueIndex];
        setButton(`Scan ${state.queueIndex + 1}/${state.queue.length}`, true);
        try {
          await activateSourceCity(item.sourceCityId);
          let available = null;
          if (state.filters.availability !== "any") {
            available = availabilityAt(item.x, item.y);
            if (!matchesAvailability(available, state.filters.availability)) continue;
          }
          if (state.filters.scanMode === "fast" && state.filters.tib === "any" && state.filters.power === 0) {
            if (available === null) available = availabilityAt(item.x, item.y);
            state.results.push({ x: item.x, y: item.y, available, layout: { tib: { 4: 0, 5: 0, 6: 0 }, power8: 0 } });
            continue;
          }
          const city = await loadCity(item);
          if (!city) continue;
          state.analysed++;
          const layout = analyseLayout(city, state.filters);
          if (!matchesResourceFilters(layout, state.filters)) continue;
          if (available === null) available = availabilityAt(item.x, item.y);
          state.results.push({ x: item.x, y: item.y, available, layout });
        } catch (error) {
          state.failures.push(`${item.x}:${item.y} (${error.message || error})`);
          console.error(`[${SCRIPT}] Failed at ${item.x}:${item.y}`, error);
        }
      }
    }

    function splitLines(lines, maxLength) {
      const parts = [];
      let current = [];
      let length = 0;
      for (const line of lines) {
        const extra = (current.length ? 1 : 0) + line.length;
        if (current.length && length + extra > maxLength) {
          parts.push(current.join("\n"));
          current = [];
          length = 0;
        }
        current.push(line);
        length += (current.length > 1 ? 1 : 0) + line.length;
      }
      if (current.length) parts.push(current.join("\n"));
      return parts;
    }
    function xmlEscape(value) {
      return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }
    function sendMail(subject, message) {
      const main = ClientLib.Data.MainData.GetInstance();
      const playerName = main.get_Player().get_Name();
      if (!playerName) fail("The current player name is unavailable.");
      const timestamp = Math.floor(Date.now() / 1000);
      const body = `<cnc><cncs>${xmlEscape(playerName)}</cncs><cncd>${timestamp}</cncd><cnct>${xmlEscape(message)}</cnct></cnc>`;
      const mailbox = main.get_Mail && main.get_Mail();
      if (mailbox && typeof mailbox.SendMail === "function") mailbox.SendMail(playerName, "", subject, body);
      else if (ClientLib.Data.Mail && ClientLib.Data.Mail.prototype && typeof ClientLib.Data.Mail.prototype.SendMail === "function") {
        ClientLib.Data.Mail.prototype.SendMail(playerName, "", subject, body);
      } else fail("ClientLib's SendMail API is unavailable.");
    }
    async function mailResults() {
      const lines = [
        "[b]Base Scanner results[/b]", `Filter: ${filterSummary(state.filters)}`,
        `Matches: ${state.results.length} | Layouts read: ${state.analysed}/${state.queue.length}`, ""
      ];
      state.results.sort((a, b) => a.x - b.x || a.y - b.y).forEach(result => lines.push(formatResult(result)));
      if (!state.results.length) lines.push("No layouts matched these filters.");
      if (state.failures.length) lines.push("", `[i]Skipped ${state.failures.length} layouts that could not be read. Details are in the browser console.[/i]`);
      const parts = splitLines(lines, CONFIG.mailTextLimit);
      for (let index = 0; index < parts.length; index++) {
        if (index > 0) await delay(CONFIG.mailDelayMs);
        setButton(`Mail ${index + 1}/${parts.length}`, false);
        const suffix = parts.length > 1 ? ` ${index + 1}/${parts.length}` : "";
        sendMail(`Base Scanner results${suffix}`, parts[index]);
      }
      return parts.length;
    }
    function restoreOwnCity() {
      if (state.originalCityId === null) return;
      try { ClientLib.Data.MainData.GetInstance().get_Cities().set_CurrentCityId(state.originalCityId); } catch (_) {}
    }
    async function run(filters) {
      if (state.running) { state.abort = true; setButton("Stopping…", false); return; }
      Object.assign(state, {
        running: true, abort: false, filters, queue: [], queueIndex: 0,
        seen: new Set(), results: [], failures: [], analysed: 0,
        rejectedGhost: 0, rejectedNotNpc: 0, resourceTypes: new Set(), sourceCityCount: 0,
        activeSourceCityId: null, npcValues: new Set(), mismatchedCityIds: 0
      });
      state.originalCityId = cityId(ClientLib.Data.MainData.GetInstance().get_Cities().get_CurrentOwnCity());
      try {
        setButton("Finding bases…", false);
        buildQueue();
        if (!state.queue.length) fail("No Forgotten camps, outposts or bases were found within attack range.");
        await scanQueue();
        if (state.abort) { log("Scan stopped by user."); return; }
        const mails = await mailResults();
        log(`Complete: ${state.results.length} matches sent in ${mails} mail(s).`, state.failures);
        setButton("Done", false);
        await delay(1500);
      } finally {
        restoreOwnCity();
        state.running = false;
        state.abort = false;
        setButton("Base Scanner", true);
      }
    }

    function makeSelect(entries, selectedValue) {
      const select = new qx.ui.form.SelectBox().set({ width: 220 });
      entries.forEach(entry => {
        const item = new qx.ui.form.ListItem(entry.label, null, entry.value);
        select.add(item);
        if (String(entry.value) === String(selectedValue)) select.setSelection([item]);
      });
      return select;
    }
    function selectedValue(select) {
      const selection = select.getSelection();
      return selection.length ? selection[0].getModel() : null;
    }
    function savedFilters() {
      const defaults = { scanMode: "fast", tib: "any", power: 0, match: "either", availability: "any" };
      try {
        const saved = Object.assign(defaults, JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "{}"));
        if (!["fast", "full"].includes(saved.scanMode)) saved.scanMode = "fast";
        if (!["any", "2x4", "1x5", "1x6"].includes(saved.tib)) saved.tib = "any";
        return saved;
      }
      catch (_) { return defaults; }
    }
    function addFormRow(container, label, control) {
      const row = new qx.ui.container.Composite(new qx.ui.layout.HBox(10)).set({ alignY: "middle" });
      row.add(new qx.ui.basic.Label(label).set({
        width: 170,
        textColor: "white",
        font: "bold"
      }));
      row.add(control);
      container.add(row);
    }
    function openDialog() {
      if (state.running) { state.abort = true; setButton("Stopping…", false); return; }
      if (state.dialog && !state.dialog.isDisposed()) { state.dialog.open(); state.dialog.center(); return; }
      const saved = savedFilters();
      const win = new qx.ui.window.Window("Base Scanner filters").set({
        width: 450, showMinimize: false, showMaximize: false,
        allowMaximize: false, modal: true, padding: 14
      });
      win.setLayout(new qx.ui.layout.VBox(10));
      const scanMode = makeSelect([
        { label: "Fast — selected statistics only", value: "fast" },
        { label: "Full — Tiberium and power", value: "full" }
      ], saved.scanMode);
      const tib = makeSelect([
        { label: "Any Tiberium layout", value: "any" },
        { label: "At least 2 x 4-field positions", value: "2x4" },
        { label: "At least 1 x 5-field position", value: "1x5" },
        { label: "At least 1 x 6-field position", value: "1x6" }
      ], saved.tib);
      const powerEntries = [{ label: "Any power layout", value: 0 }];
      // More than four is not a useful practical target within the game's
      // 40-building base limit, even where neighbouring power plants overlap.
      for (let value = 1; value <= 4; value++) {
        powerEntries.push({ label: `${value}+ eight-field power position${value === 1 ? "" : "s"}`, value });
      }
      const power = makeSelect(powerEntries, saved.power);
      const match = makeSelect([
        { label: "Either selected condition", value: "either" },
        { label: "Both selected conditions", value: "both" }
      ], saved.match);
      const availability = makeSelect([
        { label: "Any availability", value: "any" },
        { label: "Available now only", value: "available" },
        { label: "Blocked only", value: "blocked" }
      ], saved.availability);
      addFormRow(win, "Scan mode", scanMode);
      addFormRow(win, "Tiberium quality", tib);
      addFormRow(win, "Power quality", power);
      addFormRow(win, "When both are set", match);
      addFormRow(win, "Adjacent player bases", availability);
      win.add(new qx.ui.basic.Label(
        "Available now means no player-owned base occupies any of the eight adjacent map squares."
      ).set({
        rich: true,
        wrap: true,
        maxWidth: 405,
        textColor: "white",
        paddingTop: 6
      }));
      const buttons = new qx.ui.container.Composite(new qx.ui.layout.HBox(8, "right"));
      const cancel = new qx.ui.form.Button("Cancel");
      const start = new qx.ui.form.Button("Start scan");
      cancel.addListener("execute", () => win.close());
      start.addListener("execute", () => {
        const filters = {
          scanMode: String(selectedValue(scanMode) || "fast"),
          tib: String(selectedValue(tib) || "any"),
          power: Number(selectedValue(power)) || 0,
          match: String(selectedValue(match) || "either"),
          availability: String(selectedValue(availability) || "any")
        };
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(filters));
        win.close();
        run(filters).catch(showError);
      });
      buttons.add(cancel);
      buttons.add(start);
      win.add(buttons);
      qx.core.Init.getApplication().getRoot().add(win);
      state.dialog = win;
      win.open();
      win.center();
    }
    function addButtonToTopMenu(button) {
      try {
        const app = qx.core.Init.getApplication();
        const mainBar = app.getUIItem(ClientLib.Data.Missions.PATH.BAR_MENU);
        if (!mainBar || typeof mainBar.getChildren !== "function") return false;
        const barChildren = mainBar.getChildren();
        const container = barChildren.length > 1 ? barChildren[1] : barChildren[0];
        if (!container || typeof container.add !== "function" || typeof container.getChildren !== "function") return false;

        const existing = container.getChildren();
        for (const child of existing) {
          try {
            if (typeof child.getAppearance === "function" && child.getAppearance() === "button-bar-right") {
              child.setAppearance("button-bar-center");
            }
          } catch (_) {}
        }
        button.setAppearance("button-bar-right");
        button.setWidth(100);
        container.add(button);

        // Current menu builds use a separate scalable background widget.
        if (barChildren.length > 1 && barChildren[0]) {
          let width = 10;
          for (const child of container.getChildren()) {
            try { if (child.isVisible()) width += Number(child.getWidth()) || 0; } catch (_) {}
          }
          try { barChildren[0].setScale(true); } catch (_) {}
          try { barChildren[0].setWidth(width); } catch (_) {}
        }
        log("Added Base Scanner to the top menu.");
        return true;
      } catch (error) {
        log("Top-menu attachment unavailable; using floating fallback.", error);
        return false;
      }
    }
    function installButton() {
      if (state.button) return;
      const button = new qx.ui.form.Button("Base Scanner").set({
        toolTipText: "Scan Forgotten camps, outposts and bases and mail useful layouts to yourself",
        width: 125, height: 28
      });
      button.addListener("execute", openDialog);
      if (!addButtonToTopMenu(button)) {
        qx.core.Init.getApplication().getRoot().add(button, { right: 275, top: 8 });
      }
      state.button = button;
      log("Ready (v3.0.0-test.2).");
    }
    function waitForGame() {
      try {
        if (typeof qx !== "undefined" && typeof ClientLib !== "undefined" &&
            qx.core.Init.getApplication() &&
            ClientLib.Data.MainData.GetInstance().get_Player().get_Name()) {
          installButton();
          return;
        }
      } catch (_) {}
      window.setTimeout(waitForGame, 1000);
    }
    waitForGame();
  };

  const script = document.createElement("script");
  script.textContent = `(${pageMain.toString()})();`;
  (document.head || document.documentElement).appendChild(script);
  script.remove();
})();
