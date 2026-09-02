// ==UserScript==
// @name         C&C TA Alliance Offence Rankings
// @namespace    https://github.com/openai/codex-userscripts
// @version      1.5.3
// @description  Mails alliance offence, Control Hub code, and current-world Fortress badge status to the current player.
// @author       Mogsy52
// @match        https://*.alliances.commandandconquer.com/*/index.aspx*
// @match        http://*.alliances.commandandconquer.com/*/index.aspx*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
  "use strict";

  // Run in the page context. ClientLib and Qooxdoo are not exposed directly to
  // userscript sandboxes in every userscript manager/browser combination.
  const pageMain = function () {
    "use strict";

    const SCRIPT = "TA Alliance Offence";
    const CONFIG = { maxMembers: 50 };
    const state = { running: false, button: null };

    function log(...args) { console.log(`[${SCRIPT}]`, ...args); }
    function fail(message) { throw new Error(message); }
    function setStatus(text) {
      log(text);
      if (state.button && !state.button.isDisposed()) state.button.setLabel(text);
    }
    function resetButton() {
      state.running = false;
      if (state.button && !state.button.isDisposed()) {
        state.button.setLabel("Alliance Offence");
        state.button.setEnabled(true);
      }
    }

    function formatReport(rows) {
      const ranked = rows.slice().sort((a, b) => b.highest - a.highest || a.name.localeCompare(b.name));
      const codeCount = ranked.filter(row => row.hasCode).length;
      const badgedCount = ranked.filter(row => row.badged === true).length;
      const notBadgedCount = ranked.filter(row => row.badged === false).length;
      const unknownCount = ranked.filter(row => row.badged == null).length;
      const lines = [
        "[b]Alliance Offence and Fortress Status[/b]",
        `Members: ${ranked.length} | Codes: ${codeCount} | Badged: ${badgedCount} | Not badged: ${notBadgedCount}${unknownCount ? ` | Unknown: ${unknownCount}` : ""}`,
        "",
        "[b]Player | Offence | Fortress | Hub code[/b]"
      ];
      ranked.forEach((row, index) => {
        const badge = row.badged === true
          ? `Badge #${row.badgeRank != null ? row.badgeRank : "?"}`
          : row.badged === false ? "Not badged" : "Unknown";
        lines.push(`${index + 1}. [player]${row.name}[/player] | ${row.highest.toFixed(2)} | ${badge} | ${row.hasCode ? "Yes" : "No"}`);
      });
      return lines.join("\n");
    }

    function splitReport(report, maxLength) {
      const lines = report.split("\n");
      const parts = [];
      let current = [];
      for (const line of lines) {
        const candidate = current.length ? `${current.join("\n")}\n${line}` : line;
        if (candidate.length > maxLength && current.length) {
          parts.push(current.join("\n"));
          current = ["[b]Alliance Offence and Fortress Status — continued[/b]", "", line];
        } else {
          current.push(line);
        }
      }
      if (current.length) parts.push(current.join("\n"));
      return parts;
    }

    function normalizedWorldName(value) {
      return String(value == null ? "" : value).trim().replace(/\s+/g, " ").toLowerCase();
    }

    function requestPublicPlayer(name) {
      return new Promise((resolve, reject) => {
        let finished = false;
        const timer = window.setTimeout(() => {
          if (!finished) { finished = true; reject(new Error(`Profile request timed out for ${name}`)); }
        }, 10000);
        try {
          ClientLib.Net.CommunicationManager.GetInstance().SendSimpleCommand(
            "GetPublicPlayerInfoByName", { name },
            phe.cnc.Util.createEventDelegate(ClientLib.Net.CommandResult, null, function (_context, data) {
              if (finished) return;
              finished = true; window.clearTimeout(timer);
              data ? resolve(data) : reject(new Error(`Empty profile response for ${name}`));
            }), null
          );
        } catch (error) {
          finished = true; window.clearTimeout(timer); reject(error);
        }
      });
    }

    async function addBadgeStatus(rows) {
      const currentWorld = normalizedWorldName(ClientLib.Data.MainData.GetInstance().get_Server().get_Name());
      let next = 0;
      let completed = 0;
      async function worker() {
        while (next < rows.length) {
          const index = next++;
          const row = rows[index];
          try {
            const data = await requestPublicPlayer(row.name);
            const wins = Array.isArray(data.ew) ? data.ew : [];
            const worldWin = wins.find(win => normalizedWorldName(win && win.n) === currentWorld);
            row.badged = Boolean(worldWin);
            row.badgeRank = worldWin && Number.isFinite(Number(worldWin.r)) ? Number(worldWin.r) : null;
          } catch (error) {
            row.badged = null;
            row.badgeRank = null;
            log(error.message || error);
          }
          completed++;
          setStatus(`Checking badges ${completed}/${rows.length}`);
        }
      }
      await Promise.all(Array.from({ length: Math.min(4, rows.length) }, worker));
      return rows;
    }

    function xmlEscape(value) {
      return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }

    function sendToCurrentPlayer(subject, message) {
      const main = ClientLib.Data.MainData.GetInstance();
      const playerName = main.get_Player().get_Name();
      if (!playerName) fail("The current player name is unavailable.");
      const timestamp = Math.floor(Date.now() / 1000);
      const body = `<cnc><cncs>${xmlEscape(playerName)}</cncs><cncd>${timestamp}</cncd><cnct>${xmlEscape(message)}</cnct></cnc>`;
      const mailbox = main.get_Mail && main.get_Mail();
      if (mailbox && typeof mailbox.SendMail === "function") {
        mailbox.SendMail(playerName, "", subject, body);
      } else if (ClientLib.Data.Mail && ClientLib.Data.Mail.prototype && typeof ClientLib.Data.Mail.prototype.SendMail === "function") {
        // Compatibility path used by BaseScannerMailVersion.user.js.
        ClientLib.Data.Mail.prototype.SendMail(playerName, "", subject, body);
      } else {
        fail("ClientLib's SendMail API is unavailable.");
      }
    }

    function walkWidgets(root, out, seen) {
      if (!root || seen.has(root)) return;
      seen.add(root); out.push(root);
      try { (root.getChildren ? root.getChildren() : []).forEach(child => walkWidgets(child, out, seen)); } catch (_) {}
    }

    function normalized(value) {
      return String(value == null ? "" : value).toLowerCase().replace(/<[^>]*>/g, " ").replace(/[^a-z0-9]+/g, " ").trim();
    }

    function numeric(value) {
      if (typeof value === "number") return Number.isFinite(value) ? value : null;
      const match = String(value == null ? "" : value).replace(/<[^>]*>/g, "").replace(",", ".").match(/-?\d+(?:\.\d+)?/);
      return match ? Number(match[0]) : null;
    }

    function textValue(value) {
      if (value == null) return "";
      if (typeof value === "string" || typeof value === "number") return String(value).replace(/<[^>]*>/g, "").trim();
      for (const key of ["Name", "name", "n", "label", "value"]) {
        if (value[key] != null) return textValue(value[key]);
      }
      for (const method of ["get_Name", "getLabel", "getValue"]) {
        try { if (typeof value[method] === "function") return textValue(value[method]()); } catch (_) {}
      }
      return "";
    }

    function findColumn(model, matcher) {
      const count = Number(model.getColumnCount());
      for (let column = 0; column < count; column++) {
        let label = "";
        try { label = normalized(model.getColumnName(column)); } catch (_) {}
        if (matcher(label)) return column;
      }
      return -1;
    }

    function readMilitaryStrengthTable() {
      const widgets = [];
      walkWidgets(qx.core.Init.getApplication().getRoot(), widgets, new Set());
      const tables = widgets.filter(widget => {
        try { return widget instanceof qx.ui.table.Table && widget.getTableModel(); } catch (_) { return false; }
      });

      for (const table of tables) {
        const model = table.getTableModel();
        const nameColumn = findColumn(model, label => label === "name" || label.endsWith(" name"));
        const offenceColumn = findColumn(model, label =>
          (label.includes("highest") || label.includes("max")) &&
          (label.includes("off") || label.includes("attack"))
        );
        if (nameColumn < 0 || offenceColumn < 0) continue;

        const rows = [];
        const rowCount = Math.min(Number(model.getRowCount()), CONFIG.maxMembers);
        for (let row = 0; row < rowCount; row++) {
          const name = textValue(model.getValue(nameColumn, row));
          const highest = numeric(model.getValue(offenceColumn, row));
          if (name && highest != null) rows.push({ name, highest, hasCode: false });
        }
        if (rows.length) return rows;
      }
      return [];
    }

    function propertyValue(object, candidates) {
      if (!object) return null;
      const keys = Object.keys(object);
      for (const candidate of candidates) {
        const wanted = normalized(candidate).replace(/ /g, "");
        for (const key of keys) {
          if (normalized(key).replace(/ /g, "") === wanted) return object[key];
        }
        const getter = `get_${candidate}`;
        try { if (typeof object[getter] === "function") return object[getter](); } catch (_) {}
      }
      return null;
    }

    function readAllianceMemberData() {
      const alliance = ClientLib.Data.MainData.GetInstance().get_Alliance();
      let members = null;
      try { members = alliance.get_MemberDataAsArray(); } catch (_) {}
      if (!Array.isArray(members)) {
        try { members = alliance.get_MemberData(); } catch (_) {}
        members = members && (members.l || members.d || members);
        if (!Array.isArray(members)) members = Object.keys(members || {}).map(key => members[key]);
      }
      // BestOffenseLvl was confirmed against the live alliance-member schema.
      const offenceNames = ["BestOffenseLvl", "BestOffenceLvl", "HighestOffense", "HighestOffence", "HighestOffenseLevel", "HighestOffenceLevel", "MaxOffense", "MaxOffence", "OffenseLevel", "OffenceLevel"];
      return (members || []).map(member => ({
        name: textValue(propertyValue(member, ["Name", "PlayerName"])),
        highest: numeric(propertyValue(member, offenceNames)),
        hasCode: propertyValue(member, ["HasControlHubCodeBool", "HasControlHubCode"]) === true ||
          /^yes|true|1$/i.test(textValue(propertyValue(member, ["HasControlHubCodeBool", "HasControlHubCode"])))
      })).filter(row => row.name && row.highest != null).slice(0, CONFIG.maxMembers);
    }

    async function run() {
      if (state.running) return;
      state.running = true;
      state.button.setEnabled(false);
      try {
        setStatus("Reading roster…");
        let rows = readAllianceMemberData();
        if (!rows.length) rows = readMilitaryStrengthTable();
        if (!rows.length) fail("Open Alliance → Roster → Military strength, wait for the table to fill, then click Alliance Offence again.");
        await addBadgeStatus(rows);
        const subject = "Alliance Offence and Fortress Status";
        const reports = splitReport(formatReport(rows), 3800);
        setStatus("Sending to yourself…");
        for (let index = 0; index < reports.length; index++) {
          const partSubject = reports.length > 1 ? `${subject} (${index + 1}/${reports.length})` : subject;
          sendToCurrentPlayer(partSubject, reports[index]);
          // Give the command queue time to accept one mail before adding another.
          if (index + 1 < reports.length) await new Promise(resolve => window.setTimeout(resolve, 500));
        }
      } catch (error) {
        console.error(`[${SCRIPT}]`, error);
        setStatus("Alliance Offence failed");
        window.setTimeout(() => {
          try { qx.core.Init.getApplication().showError(String(error.message || error)); } catch (_) {}
        }, 0);
      } finally {
        resetButton();
      }
    }

    function installButton() {
      if (state.button) return;
      const app = qx.core.Init.getApplication();
      const button = new qx.ui.form.Button("Alliance Offence").set({
        toolTipText: "Mail the alliance offence ranking to your own player account",
        width: 140, height: 28
      });
      button.addListener("execute", run);
      // A root-level button is resilient to menu-bar layout changes and remains
      // entirely inside the game's Qooxdoo interface (no DOM scraping).
      app.getRoot().add(button, { right: 125, top: 8 });
      state.button = button;
      log("ready");
    }

    function waitForGame() {
      try {
        if (typeof qx !== "undefined" && typeof ClientLib !== "undefined" &&
            qx.core.Init.getApplication() && ClientLib.Data.MainData.GetInstance().get_Player().get_Name()) {
          installButton(); return;
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
