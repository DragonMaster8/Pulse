/* ============================================================
   PULSE — API Client
   Pure-frontend Postman alternative. No build, no backend.
   ============================================================ */

(() => {
    "use strict";

    /* ----------------------------------------------------------
       Storage keys + simple wrapper around localStorage
       ---------------------------------------------------------- */
    const STORAGE = {
        THEME: "pulse.theme",
        HISTORY: "pulse.history",
        VARIABLES: "pulse.variables",
        BODY_TYPE: "pulse.bodyType",
        WRAP: "pulse.responseWrap",
        SETTINGS: "pulse.settings",
    };

    const HISTORY_LIMIT = 100;

    /* ----------------------------------------------------------
       Built-in CORS proxy providers.
       {url} is replaced with the URL-encoded target.
       The cascade engine tries them in order until one succeeds.
       ---------------------------------------------------------- */
    const PROXY_PROVIDERS = [
        {
            id: "corsproxy",
            label: "corsproxy.io",
            template: "https://corsproxy.io/?{url}",
            testUrl: "https://corsproxy.io/?https://httpbin.org/get",
        },
        {
            id: "allorigins",
            label: "allorigins.win",
            template: "https://api.allorigins.win/raw?url={url}",
            testUrl: "https://api.allorigins.win/raw?url=https://httpbin.org/get",
        },
        {
            id: "thingproxy",
            label: "thingproxy (freeboard)",
            template: "https://thingproxy.freeboard.io/fetch/{raw_url}",
            testUrl: "https://thingproxy.freeboard.io/fetch/https://httpbin.org/get",
        },
        {
            id: "corsproxy_org",
            label: "corsproxy.org",
            template: "https://corsproxy.org/?{url}",
            testUrl: "https://corsproxy.org/?https%3A%2F%2Fhttpbin.org%2Fget",
        },
        {
            id: "codetabs",
            label: "codetabs.com",
            template: "https://api.codetabs.com/v1/proxy?quest={url}",
            testUrl: "https://api.codetabs.com/v1/proxy?quest=https://httpbin.org/get",
        },
    ];

    const DEFAULT_SETTINGS = {
        autoHeaders: true,
        autoProxyFallback: true,     // try proxy on failure
        proxyCascade: true,          // try ALL proxies in order, not just one
        alwaysProxy: false,
        preferredProxy: "auto",      // "auto" = cascade; or a specific provider id
        customProxyTemplate: "",
        reachableProxies: [],        // populated by connectivity check
    };

    const store = {
        get(key, fallback) {
            try {
                const raw = localStorage.getItem(key);
                return raw == null ? fallback : JSON.parse(raw);
            } catch {
                return fallback;
            }
        },
        set(key, value) {
            try {
                localStorage.setItem(key, JSON.stringify(value));
            } catch {
                /* quota exceeded — ignore silently */
            }
        },
        remove(key) {
            try {
                localStorage.removeItem(key);
            } catch {
                /* ignore */
            }
        },
    };

    /* ----------------------------------------------------------
       DOM helpers
       ---------------------------------------------------------- */
    const $ = (sel, root = document) => root.querySelector(sel);
    const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

    const escapeHTML = (str) =>
        String(str)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");

    /* ----------------------------------------------------------
       Application state — single source of truth
       ---------------------------------------------------------- */
    const state = {
        kv: {
            params: [],
            headers: [],
            formData: [],
            urlEncoded: [],
            variables: [],
        },
        bodyType: "none",
        bodyJson: "",
        history: [],
        lastResponse: null,
        settings: { ...DEFAULT_SETTINGS },
    };

    /* ----------------------------------------------------------
       Settings — persisted to localStorage; controls smart-mode
       behavior (auto-headers, proxy cascade, etc.)
       ---------------------------------------------------------- */
    const Settings = {
        load() {
            const saved = store.get(STORAGE.SETTINGS, {});
            state.settings = { ...DEFAULT_SETTINGS, ...(saved || {}) };
        },

        save() {
            store.set(STORAGE.SETTINGS, state.settings);
        },

        // Build a proxied URL from a template
        applyTemplate(template, targetUrl) {
            return template
                .replace("{url}", encodeURIComponent(targetUrl))
                .replace("{raw_url}", targetUrl);
        },

        // Get the ordered list of proxy templates to try.
        // If preferredProxy is set to a specific provider, that goes first.
        // Custom template is always tried first when present.
        getProxyChain() {
            const chain = [];
            const s = state.settings;

            // Custom goes first if configured
            const custom = (s.customProxyTemplate || "").trim();
            if (custom && (/\{url\}/.test(custom) || /\{raw_url\}/.test(custom))) {
                chain.push({ id: "custom", label: "Custom proxy", template: custom });
            }

            // If a specific preferred proxy, put it first (after custom)
            if (s.preferredProxy && s.preferredProxy !== "auto") {
                const pref = PROXY_PROVIDERS.find((p) => p.id === s.preferredProxy);
                if (pref) chain.push(pref);
            }

            // If cascade mode: add all others that aren't already in the chain
            if (s.proxyCascade || s.preferredProxy === "auto") {
                // Prefer reachable ones first (from last health check)
                const reachable = new Set(s.reachableProxies || []);
                const sorted = [...PROXY_PROVIDERS].sort((a, b) => {
                    const aOk = reachable.has(a.id) ? 0 : 1;
                    const bOk = reachable.has(b.id) ? 0 : 1;
                    return aOk - bOk;
                });
                for (const p of sorted) {
                    if (!chain.some((c) => c.id === p.id)) {
                        chain.push(p);
                    }
                }
            }

            return chain;
        },

        // Test which proxies are reachable from this network.
        // Uses a lightweight HEAD/GET with a short timeout.
        async runHealthCheck() {
            const results = [];
            const container = $("#proxyHealthResults");
            container.innerHTML = `<span class="health-checking">Testing ${PROXY_PROVIDERS.length} providers…</span>`;

            const checks = PROXY_PROVIDERS.map(async (provider) => {
                const start = performance.now();
                try {
                    const ctrl = new AbortController();
                    const timeout = setTimeout(() => ctrl.abort(), 6000);
                    const resp = await fetch(provider.testUrl, {
                        method: "GET",
                        signal: ctrl.signal,
                    });
                    clearTimeout(timeout);
                    const ms = Math.round(performance.now() - start);
                    if (resp.ok || resp.status === 200) {
                        results.push({ id: provider.id, ok: true, ms });
                    } else {
                        results.push({ id: provider.id, ok: false, ms, status: resp.status });
                    }
                } catch {
                    const ms = Math.round(performance.now() - start);
                    results.push({ id: provider.id, ok: false, ms });
                }
            });

            await Promise.allSettled(checks);

            // Sort: reachable first, then by speed
            results.sort((a, b) => {
                if (a.ok !== b.ok) return a.ok ? -1 : 1;
                return a.ms - b.ms;
            });

            // Persist reachable list so the cascade uses them first
            state.settings.reachableProxies = results
                .filter((r) => r.ok)
                .map((r) => r.id);
            this.save();

            // Render results
            if (results.filter((r) => r.ok).length === 0) {
                container.innerHTML = `
                    <span class="health-result health-result--bad">
                        All proxies are blocked on this network.<br/>
                        You'll need IT to whitelist one of these domains, or deploy your own CORS proxy internally.
                    </span>
                `;
            } else {
                container.innerHTML = results
                    .map((r) => {
                        const provider = PROXY_PROVIDERS.find((p) => p.id === r.id);
                        const label = provider ? provider.label : r.id;
                        if (r.ok) {
                            return `<span class="health-result health-result--ok">✓ ${escapeHTML(label)} <span class="health-ms">${r.ms} ms</span></span>`;
                        }
                        return `<span class="health-result health-result--fail">✗ ${escapeHTML(label)} <span class="health-ms">blocked</span></span>`;
                    })
                    .join("");
            }

            const okCount = results.filter((r) => r.ok).length;
            if (okCount > 0) {
                Toast.show(`${okCount} of ${PROXY_PROVIDERS.length} proxies reachable`, "success");
            } else {
                Toast.show("No proxies reachable — see Settings for guidance", "error", 4000);
            }
        },

        renderUI() {
            $("#autoHeadersToggle").checked = state.settings.autoHeaders;
            $("#autoProxyToggle").checked = state.settings.autoProxyFallback;
            $("#alwaysProxyToggle").checked = state.settings.alwaysProxy;
            $("#proxyCascadeToggle").checked = state.settings.proxyCascade;
            $("#preferredProxySelect").value = state.settings.preferredProxy;
            $("#proxyTemplateInput").value = state.settings.customProxyTemplate;
            $("#customProxyField").hidden =
                state.settings.preferredProxy !== "custom";
        },

        open() {
            this.renderUI();
            const modal = $("#settingsModal");
            modal.hidden = false;
            requestAnimationFrame(() => $("#closeSettingsBtn").focus());
        },

        close() {
            $("#settingsModal").hidden = true;
        },

        reset() {
            state.settings = { ...DEFAULT_SETTINGS };
            this.save();
            this.renderUI();
            Toast.show("Settings reset to defaults", "info");
        },

        bind() {
            $("#settingsBtn").addEventListener("click", () => this.open());

            $$("#settingsModal [data-close-modal]").forEach((el) =>
                el.addEventListener("click", () => this.close())
            );

            document.addEventListener("keydown", (e) => {
                if (e.key === "Escape" && !$("#settingsModal").hidden) {
                    this.close();
                }
            });

            const bindToggle = (id, key) => {
                $(`#${id}`).addEventListener("change", (e) => {
                    state.settings[key] = e.target.checked;
                    this.save();
                });
            };
            bindToggle("autoHeadersToggle", "autoHeaders");
            bindToggle("autoProxyToggle", "autoProxyFallback");
            bindToggle("alwaysProxyToggle", "alwaysProxy");
            bindToggle("proxyCascadeToggle", "proxyCascade");

            $("#preferredProxySelect").addEventListener("change", (e) => {
                state.settings.preferredProxy = e.target.value;
                // Show custom field when "custom" is selected
                $("#customProxyField").hidden = e.target.value !== "custom";
                this.save();
            });

            $("#proxyTemplateInput").addEventListener("input", (e) => {
                state.settings.customProxyTemplate = e.target.value;
                this.save();
            });

            $("#resetSettingsBtn").addEventListener("click", () => this.reset());
            $("#healthCheckBtn").addEventListener("click", () =>
                this.runHealthCheck()
            );
        },
    };

    /* ----------------------------------------------------------
       Theme
       ---------------------------------------------------------- */
    const Theme = {
        init() {
            const saved =
                store.get(STORAGE.THEME) ||
                (window.matchMedia &&
                window.matchMedia("(prefers-color-scheme: light)").matches
                    ? "light"
                    : "dark");
            this.set(saved);
            $("#themeToggle").addEventListener("click", () => {
                const next =
                    document.body.dataset.theme === "dark" ? "light" : "dark";
                this.set(next);
            });
        },
        set(theme) {
            document.body.dataset.theme = theme;
            store.set(STORAGE.THEME, theme);
        },
    };

    /* ----------------------------------------------------------
       Toast notifications
       ---------------------------------------------------------- */
    const Toast = {
        show(message, type = "info", duration = 2400) {
            const el = document.createElement("div");
            el.className = `toast toast--${type}`;
            el.textContent = message;
            $("#toastContainer").appendChild(el);
            setTimeout(() => {
                el.classList.add("is-leaving");
                setTimeout(() => el.remove(), 220);
            }, duration);
        },
    };

    /* ----------------------------------------------------------
       Generic key-value editor
       Handles: params, headers, formData, urlEncoded, variables
       ---------------------------------------------------------- */
    const KV = {
        // Render all editors based on state
        renderAll() {
            Object.keys(state.kv).forEach((kind) => this.render(kind));
            this.refreshBadges();
        },

        render(kind) {
            const container = $(`[data-kv="${kind}"]`);
            if (!container) return;

            container.innerHTML = "";

            // Always keep at least one empty row so users can start typing
            if (state.kv[kind].length === 0) {
                state.kv[kind].push({ key: "", value: "", enabled: true });
            }

            state.kv[kind].forEach((row) => {
                container.appendChild(this.makeRow(kind, row));
            });
        },

        // Build a single row. We keep a reference to the row object (rather than
        // a fixed index) so we can do surgical DOM updates without re-rendering
        // the whole list — this preserves focus while the user is typing.
        makeRow(kind, row) {
            const wrap = document.createElement("div");
            wrap.className = "kv-row";
            wrap.innerHTML = `
                <label class="kv-row__check" title="Enable / disable">
                    <input type="checkbox" ${row.enabled ? "checked" : ""} />
                </label>
                <input type="text" placeholder="Key" value="${escapeHTML(row.key)}" />
                <input type="text" placeholder="Value" value="${escapeHTML(row.value)}" />
                <button class="kv-row__delete" title="Remove" aria-label="Remove row">
                    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
                        <path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M6 6l12 12M6 18L18 6"/>
                    </svg>
                </button>
            `;

            const check = wrap.querySelector('input[type="checkbox"]');
            const textInputs = wrap.querySelectorAll('input[type="text"]');
            const keyInput = textInputs[0];
            const valInput = textInputs[1];
            const delBtn = wrap.querySelector(".kv-row__delete");

            const sideEffects = () => {
                this.refreshBadges();
                if (kind === "variables") {
                    this.persistVariables();
                    this.updateEnvIndicator();
                }
            };

            check.addEventListener("change", () => {
                row.enabled = check.checked;
                sideEffects();
            });
            keyInput.addEventListener("input", () => {
                row.key = keyInput.value;
                sideEffects();
                maybeAppendBlank();
            });
            valInput.addEventListener("input", () => {
                row.value = valInput.value;
                sideEffects();
                maybeAppendBlank();
            });

            // Append a fresh blank row when the user types into the last row.
            // We do it via direct DOM append (no re-render) so focus is kept.
            const maybeAppendBlank = () => {
                const list = state.kv[kind];
                const last = list[list.length - 1];
                const isLast = last === row;
                if (isLast && (row.key || row.value)) {
                    const newRow = { key: "", value: "", enabled: true };
                    list.push(newRow);
                    const container = $(`[data-kv="${kind}"]`);
                    container.appendChild(this.makeRow(kind, newRow));
                }
            };

            delBtn.addEventListener("click", () => {
                const list = state.kv[kind];
                const idx = list.indexOf(row);
                if (idx === -1) return;
                list.splice(idx, 1);
                wrap.remove();
                // Always keep at least one empty row visible
                if (list.length === 0) {
                    const newRow = { key: "", value: "", enabled: true };
                    list.push(newRow);
                    $(`[data-kv="${kind}"]`).appendChild(
                        this.makeRow(kind, newRow)
                    );
                }
                sideEffects();
            });

            return wrap;
        },

        // Count active (enabled + non-empty key) rows
        activeCount(kind) {
            return state.kv[kind].filter(
                (r) => r.enabled && r.key.trim() !== ""
            ).length;
        },

        refreshBadges() {
            const setBadge = (id, kinds) => {
                const total = kinds.reduce(
                    (acc, k) => acc + this.activeCount(k),
                    0
                );
                const el = $(`#${id}`);
                if (el) el.textContent = total > 0 ? total : "";
            };
            setBadge("paramsBadge", ["params"]);
            setBadge("headersBadge", ["headers"]);
            // Body badge counts differ by body type
            const bodyBadge = $("#bodyBadge");
            if (bodyBadge) {
                let count = 0;
                if (state.bodyType === "json")
                    count = state.bodyJson.trim() ? 1 : 0;
                else if (state.bodyType === "form-data")
                    count = this.activeCount("formData");
                else if (state.bodyType === "urlencoded")
                    count = this.activeCount("urlEncoded");
                bodyBadge.textContent = count > 0 ? count : "";
            }
        },

        persistVariables() {
            store.set(STORAGE.VARIABLES, state.kv.variables);
        },

        loadVariables() {
            const saved = store.get(STORAGE.VARIABLES);
            if (Array.isArray(saved)) {
                state.kv.variables = saved;
            }
        },

        updateEnvIndicator() {
            const btn = $("#envBtn");
            const label = $("#envLabel");
            const count = this.activeCount("variables");
            if (count > 0) {
                btn.classList.add("has-vars");
                label.textContent = `${count} variable${count > 1 ? "s" : ""}`;
            } else {
                btn.classList.remove("has-vars");
                label.textContent = "Environment";
            }
        },

        // Get a plain object of active variables, used to substitute {{var}}
        variablesMap() {
            const map = {};
            state.kv.variables.forEach((row) => {
                if (row.enabled && row.key.trim()) {
                    map[row.key.trim()] = row.value;
                }
            });
            return map;
        },
    };

    /* ----------------------------------------------------------
       Variable interpolation: replace {{name}} occurrences
       ---------------------------------------------------------- */
    function interpolate(str, vars) {
        if (typeof str !== "string") return str;
        return str.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (full, name) => {
            return Object.prototype.hasOwnProperty.call(vars, name)
                ? vars[name]
                : full;
        });
    }

    /* ----------------------------------------------------------
       Tabs (request + response)
       ---------------------------------------------------------- */
    function setupTabs() {
        // Request tabs
        $$(".request-tabs .tab").forEach((tab) => {
            tab.addEventListener("click", () => {
                $$(".request-tabs .tab").forEach((t) => {
                    t.classList.remove("tab--active");
                    t.setAttribute("aria-selected", "false");
                });
                $$(".request-tabs .tab-panel").forEach((p) =>
                    p.classList.remove("tab-panel--active")
                );
                tab.classList.add("tab--active");
                tab.setAttribute("aria-selected", "true");
                $(
                    `.request-tabs .tab-panel[data-panel="${tab.dataset.tab}"]`
                ).classList.add("tab-panel--active");
            });
        });

        // Response tabs
        $$(".response-panel .tab").forEach((tab) => {
            tab.addEventListener("click", () => {
                $$(".response-panel .tab").forEach((t) => {
                    t.classList.remove("tab--active");
                    t.setAttribute("aria-selected", "false");
                });
                $$(".response-panel .response-tab").forEach((p) =>
                    p.classList.remove("response-tab--active")
                );
                tab.classList.add("tab--active");
                tab.setAttribute("aria-selected", "true");
                $(
                    `.response-panel .response-tab[data-rpanel="${tab.dataset.rtab}"]`
                ).classList.add("response-tab--active");
            });
        });
    }

    /* ----------------------------------------------------------
       Body type switching
       ---------------------------------------------------------- */
    function setupBodyType() {
        const sections = {
            none: $("#bodyNone"),
            json: $("#bodyJson"),
            "form-data": $("#bodyFormData"),
            urlencoded: $("#bodyUrlEncoded"),
        };

        const apply = (type) => {
            state.bodyType = type;
            store.set(STORAGE.BODY_TYPE, type);
            Object.entries(sections).forEach(([k, el]) => {
                el.hidden = k !== type;
            });
            KV.refreshBadges();
        };

        $$('input[name="bodyType"]').forEach((radio) => {
            radio.addEventListener("change", (e) => apply(e.target.value));
        });

        // Restore previous selection
        const saved = store.get(STORAGE.BODY_TYPE) || "none";
        const radio = $(`input[name="bodyType"][value="${saved}"]`);
        if (radio) {
            radio.checked = true;
            apply(saved);
        }

        // JSON body input + validity
        const jsonInput = $("#bodyJsonInput");
        const validity = $("#jsonValidity");

        const checkJson = () => {
            state.bodyJson = jsonInput.value;
            const text = jsonInput.value.trim();
            if (!text) {
                validity.textContent = "";
                validity.className = "body-toolbar__hint";
            } else {
                try {
                    JSON.parse(text);
                    validity.textContent = "✓ Valid JSON";
                    validity.className = "body-toolbar__hint valid";
                } catch (err) {
                    validity.textContent = "⚠ " + err.message;
                    validity.className = "body-toolbar__hint invalid";
                }
            }
            KV.refreshBadges();
        };
        jsonInput.addEventListener("input", checkJson);

        // Tab key inserts two spaces in the JSON editor
        jsonInput.addEventListener("keydown", (e) => {
            if (e.key === "Tab") {
                e.preventDefault();
                const start = jsonInput.selectionStart;
                const end = jsonInput.selectionEnd;
                jsonInput.value =
                    jsonInput.value.slice(0, start) +
                    "  " +
                    jsonInput.value.slice(end);
                jsonInput.selectionStart = jsonInput.selectionEnd = start + 2;
                checkJson();
            }
        });

        // Beautify button
        $("#formatJsonBtn").addEventListener("click", () => {
            const text = jsonInput.value.trim();
            if (!text) return;
            try {
                jsonInput.value = JSON.stringify(JSON.parse(text), null, 2);
                checkJson();
                Toast.show("JSON formatted", "success");
            } catch (err) {
                Toast.show("Invalid JSON: " + err.message, "error");
            }
        });
    }

    /* ----------------------------------------------------------
       Method select coloring
       ---------------------------------------------------------- */
    function setupMethodSelect() {
        const select = $("#methodSelect");
        const sync = () => {
            select.dataset.method = select.value;
        };
        select.addEventListener("change", sync);
        sync();
    }

    /* ----------------------------------------------------------
       Build a request from the current state
       Returns { method, url, headers, body, urlError? }
       ---------------------------------------------------------- */
    function buildRequest() {
        const vars = KV.variablesMap();
        const method = $("#methodSelect").value;
        const rawUrl = $("#urlInput").value.trim();

        if (!rawUrl) {
            return { error: "Please enter a request URL" };
        }

        let interpolated = interpolate(rawUrl, vars);

        // Auto-prepend protocol if missing
        if (!/^https?:\/\//i.test(interpolated) && !interpolated.startsWith("//")) {
            interpolated = "https://" + interpolated;
        }

        // Append query params
        let url;
        try {
            url = new URL(interpolated);
        } catch {
            return { error: "Invalid URL: " + interpolated };
        }
        state.kv.params.forEach((p) => {
            if (p.enabled && p.key.trim()) {
                url.searchParams.append(
                    interpolate(p.key, vars),
                    interpolate(p.value, vars)
                );
            }
        });

        // Build headers
        const headers = {};
        state.kv.headers.forEach((h) => {
            if (h.enabled && h.key.trim()) {
                headers[interpolate(h.key, vars)] = interpolate(h.value, vars);
            }
        });

        // Build body
        let body;
        const noBodyMethods = new Set(["GET", "HEAD"]);
        if (!noBodyMethods.has(method)) {
            if (state.bodyType === "json") {
                const raw = state.bodyJson.trim();
                if (raw) {
                    body = interpolate(raw, vars);
                    if (
                        !Object.keys(headers).some(
                            (k) => k.toLowerCase() === "content-type"
                        )
                    ) {
                        headers["Content-Type"] = "application/json";
                    }
                }
            } else if (state.bodyType === "form-data") {
                const fd = new FormData();
                state.kv.formData.forEach((row) => {
                    if (row.enabled && row.key.trim()) {
                        fd.append(
                            interpolate(row.key, vars),
                            interpolate(row.value, vars)
                        );
                    }
                });
                body = fd;
                // Don't set Content-Type — fetch will set it with the multipart boundary
            } else if (state.bodyType === "urlencoded") {
                const params = new URLSearchParams();
                state.kv.urlEncoded.forEach((row) => {
                    if (row.enabled && row.key.trim()) {
                        params.append(
                            interpolate(row.key, vars),
                            interpolate(row.value, vars)
                        );
                    }
                });
                body = params.toString();
                if (
                    body &&
                    !Object.keys(headers).some(
                        (k) => k.toLowerCase() === "content-type"
                    )
                ) {
                    headers["Content-Type"] =
                        "application/x-www-form-urlencoded";
                }
            }
        }

        return {
            method,
            url: url.toString(),
            headers,
            body,
        };
    }

    /* ----------------------------------------------------------
       Apply "smart" defaults: add common headers when missing.
       We only set headers the browser actually allows from JS.
       ---------------------------------------------------------- */
    function applyAutoHeaders(req) {
        const has = (name) =>
            Object.keys(req.headers).some(
                (k) => k.toLowerCase() === name.toLowerCase()
            );
        if (!has("Accept")) {
            req.headers["Accept"] = "*/*";
        }
        // Content-Type for JSON/urlencoded bodies is already added in buildRequest.
    }

    /* ----------------------------------------------------------
       Single fetch attempt. Returns { response, text, error }.
       ---------------------------------------------------------- */
    async function attemptFetch(url, req) {
        try {
            const response = await fetch(url, {
                method: req.method,
                headers: req.headers,
                body: req.body,
            });
            let text = "";
            try {
                text = await response.text();
            } catch {
                /* opaque or HEAD — leave empty */
            }
            return { response, text };
        } catch (error) {
            return { error };
        }
    }

    /* ----------------------------------------------------------
       Send the request via fetch, with smart cascade:
          1. Apply auto-headers (if enabled)
          2. If "always proxy": cascade through proxy chain directly
          3. Else: try direct first; on failure, cascade through proxies
       The cascade tries every available proxy in order until one works.
       ---------------------------------------------------------- */
    async function sendRequest() {
        const req = buildRequest();
        if (req.error) {
            Toast.show(req.error, "error");
            return;
        }

        if (state.settings.autoHeaders) {
            applyAutoHeaders(req);
        }

        const sendBtn = $("#sendBtn");
        const loadingBar = $("#loadingBar");
        sendBtn.disabled = true;
        loadingBar.classList.add("is-loading");

        const startTime = performance.now();
        let attempt;
        let viaProxy = false;
        let usedProxyLabel = "";

        if (state.settings.alwaysProxy) {
            // Skip direct, go straight to proxy cascade
            const cascadeResult = await cascadeProxies(req);
            attempt = cascadeResult.attempt;
            viaProxy = cascadeResult.ok;
            usedProxyLabel = cascadeResult.label;
        } else {
            // Try direct first
            attempt = await attemptFetch(req.url, req);

            // On failure, cascade through proxies if enabled
            if (attempt.error && state.settings.autoProxyFallback) {
                Toast.show("Direct request failed — trying proxies…", "info", 2000);
                const cascadeResult = await cascadeProxies(req);
                if (cascadeResult.ok) {
                    attempt = cascadeResult.attempt;
                    viaProxy = true;
                    usedProxyLabel = cascadeResult.label;
                }
                // Otherwise keep original error
            }
        }

        const elapsed = Math.round(performance.now() - startTime);
        loadingBar.classList.remove("is-loading");
        sendBtn.disabled = false;

        if (attempt.error) {
            renderError(attempt.error, elapsed, req, { triedProxy: true });
            saveHistoryEntry(req, {
                error: attempt.error.message,
                duration: elapsed,
            });
            return;
        }

        renderResponse(attempt.response, attempt.text, elapsed, req, {
            viaProxy,
            proxyLabel: usedProxyLabel,
        });

        saveHistoryEntry(req, {
            status: attempt.response.status,
            statusText: attempt.response.statusText,
            duration: elapsed,
            size: byteLength(attempt.text),
            viaProxy,
            proxyLabel: usedProxyLabel,
        });
    }

    /* ----------------------------------------------------------
       Cascade through all available proxy providers in order.
       Returns { ok: boolean, attempt: {...}, label: string }
       ---------------------------------------------------------- */
    async function cascadeProxies(req) {
        const chain = Settings.getProxyChain();
        let lastAttempt = { error: new Error("No proxy providers configured") };

        for (const provider of chain) {
            const proxiedUrl = Settings.applyTemplate(provider.template, req.url);
            const attempt = await attemptFetch(proxiedUrl, req);
            if (!attempt.error) {
                return { ok: true, attempt, label: provider.label };
            }
            lastAttempt = attempt;
        }

        return { ok: false, attempt: lastAttempt, label: "" };
    }

    function byteLength(str) {
        try {
            return new Blob([str]).size;
        } catch {
            return str.length;
        }
    }

    function formatBytes(bytes) {
        if (bytes === 0) return "0 B";
        const units = ["B", "KB", "MB", "GB"];
        const i = Math.floor(Math.log(bytes) / Math.log(1024));
        return (bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 2) + " " + units[i];
    }

    function statusClass(status) {
        if (status >= 200 && status < 300) return "status-2xx";
        if (status >= 300 && status < 400) return "status-3xx";
        if (status >= 400 && status < 500) return "status-4xx";
        if (status >= 500) return "status-5xx";
        return "status-err";
    }

    /* ----------------------------------------------------------
       Render a successful (or HTTP-error) response
       ---------------------------------------------------------- */
    function renderResponse(response, text, duration, req, opts = {}) {
        // ---- meta header (status, time, size, optional proxy badge) ----
        const meta = $("#responseMeta");
        const size = byteLength(text);
        const cls = statusClass(response.status);
        const proxyBadge = opts.viaProxy
            ? `<span class="proxy-badge" title="Routed through ${escapeHTML(
                  opts.proxyLabel || "CORS proxy"
              )}">via ${escapeHTML(opts.proxyLabel || "proxy")}</span>`
            : "";
        meta.innerHTML = `
            <span class="status-badge ${cls}">${response.status} ${escapeHTML(
            response.statusText || ""
        )}</span>
            ${proxyBadge}
            <span class="response-meta__item">
                <span class="response-meta__label">Time</span>
                <span class="response-meta__value">${duration} ms</span>
            </span>
            <span class="response-meta__item">
                <span class="response-meta__label">Size</span>
                <span class="response-meta__value">${formatBytes(size)}</span>
            </span>
        `;

        // ---- body ----
        const bodyEl = $("#responseBody");
        const contentType = response.headers.get("content-type") || "";
        let pretty = text;
        let isJSON = false;

        if (
            contentType.includes("application/json") ||
            contentType.includes("+json")
        ) {
            try {
                pretty = JSON.stringify(JSON.parse(text), null, 2);
                isJSON = true;
            } catch {
                /* leave as-is */
            }
        } else if (text && /^[\s]*[{[]/.test(text)) {
            // try to parse anyway
            try {
                pretty = JSON.stringify(JSON.parse(text), null, 2);
                isJSON = true;
            } catch {
                /* not JSON */
            }
        }

        if (!text) {
            bodyEl.innerHTML = `<code class="placeholder">(empty response body)</code>`;
        } else if (isJSON) {
            bodyEl.innerHTML = `<code>${highlightJSON(pretty)}</code>`;
        } else {
            bodyEl.innerHTML = `<code>${escapeHTML(pretty)}</code>`;
        }

        // ---- headers ----
        const headersEl = $("#responseHeaders");
        const entries = [];
        response.headers.forEach((value, key) => {
            entries.push([key, value]);
        });

        $("#rHeadersBadge").textContent = entries.length || "";

        if (entries.length === 0) {
            headersEl.innerHTML = `<p class="placeholder">No headers exposed by the response (often due to CORS).</p>`;
        } else {
            const rows = entries
                .map(
                    ([k, v]) =>
                        `<tr><td>${escapeHTML(k)}</td><td>${escapeHTML(
                            v
                        )}</td></tr>`
                )
                .join("");
            headersEl.innerHTML = `
                <table class="headers-table">
                    <thead>
                        <tr><th>Header</th><th>Value</th></tr>
                    </thead>
                    <tbody>${rows}</tbody>
                </table>
            `;
        }

        // ---- cURL ----
        $("#curlPreview").innerHTML = `<code>${escapeHTML(
            generateCurl(req)
        )}</code>`;

        // Cache for copy
        state.lastResponse = { text: pretty, isJSON };
    }

    /* ----------------------------------------------------------
       Render a network/CORS/etc. error
       ---------------------------------------------------------- */
    function renderError(err, duration, req, opts = {}) {
        const meta = $("#responseMeta");
        meta.innerHTML = `
            <span class="status-badge status-err">Network Error</span>
            <span class="response-meta__item">
                <span class="response-meta__label">Time</span>
                <span class="response-meta__value">${duration} ms</span>
            </span>
        `;

        const friendly = explainFetchError(err, opts);
        $("#responseBody").innerHTML = `<code>${escapeHTML(friendly)}</code>`;
        $("#responseHeaders").innerHTML = `<p class="placeholder">No headers — request never reached the server (or CORS blocked the response).</p>`;
        $("#rHeadersBadge").textContent = "";
        $("#curlPreview").innerHTML = `<code>${escapeHTML(
            generateCurl(req)
        )}</code>`;

        state.lastResponse = { text: friendly, isJSON: false };
    }

    function explainFetchError(err, opts = {}) {
        const msg = err && err.message ? err.message : String(err);
        const lines = [
            `${err && err.name ? err.name : "Error"}: ${msg}`,
            "",
            "Common causes:",
            "  • CORS — the server didn't include 'Access-Control-Allow-Origin' for this origin.",
            "  • Mixed content — calling http:// from an https:// page is blocked.",
            "  • DNS / unreachable host — the URL might be wrong or the server is down.",
            "  • Browser extensions (ad-block, privacy) blocking the request.",
            "  • Corporate firewall / proxy intercepting outbound traffic.",
            "",
        ];

        if (opts.triedProxy) {
            lines.push(
                "Pulse already tried the configured CORS proxy — it failed too.",
                "Try a different proxy provider in Settings, or run the cURL command in your terminal."
            );
        } else if (state.settings.autoProxyFallback) {
            lines.push(
                "Pulse tried to retry through a CORS proxy automatically, but the proxy also rejected the request.",
                "Open Settings to choose a different proxy provider."
            );
        } else {
            lines.push(
                "Tip: Enable 'Auto-retry through CORS proxy' in Settings to bypass CORS automatically.",
                "Or copy the cURL command and run it in your terminal."
            );
        }

        return lines.join("\n");
    }

    /* ----------------------------------------------------------
       JSON syntax highlighter (no external dependencies)
       ----------------------------------------------------------
       The regex runs against the *raw* JSON. The unmatched residue
       can only be structural characters ({} [] , : whitespace) —
       none of which need HTML escaping. Token contents (strings)
       can contain <, >, & and are escaped inside the replacer.
    */
    function highlightJSON(json) {
        return json.replace(
            /("(\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g,
            (match) => {
                let cls = "jsx-number";
                if (/^"/.test(match)) {
                    cls = /:$/.test(match) ? "jsx-key" : "jsx-string";
                } else if (/^(true|false)$/.test(match)) {
                    cls = "jsx-bool";
                } else if (/^null$/.test(match)) {
                    cls = "jsx-null";
                }
                return `<span class="${cls}">${escapeHTML(match)}</span>`;
            }
        );
    }

    /* ----------------------------------------------------------
       cURL command generator
       ---------------------------------------------------------- */
    function generateCurl(req) {
        const parts = [`curl --request ${req.method}`];
        // Use double quotes; escape inner double quotes by switching to single quotes for body.
        parts.push(`  --url '${req.url.replace(/'/g, "'\\''")}'`);

        Object.entries(req.headers || {}).forEach(([k, v]) => {
            parts.push(`  --header '${k}: ${String(v).replace(/'/g, "'\\''")}'`);
        });

        if (req.body) {
            if (req.body instanceof FormData) {
                req.body.forEach((value, key) => {
                    parts.push(
                        `  --form '${key}=${String(value).replace(/'/g, "'\\''")}'`
                    );
                });
            } else if (typeof req.body === "string") {
                parts.push(
                    `  --data '${req.body.replace(/'/g, "'\\''")}'`
                );
            }
        }

        return parts.join(" \\\n");
    }

    /* ----------------------------------------------------------
       History
       ---------------------------------------------------------- */
    const History = {
        load() {
            state.history = store.get(STORAGE.HISTORY, []) || [];
            this.render();
        },

        save() {
            // keep the list trimmed
            state.history = state.history.slice(0, HISTORY_LIMIT);
            store.set(STORAGE.HISTORY, state.history);
        },

        add(entry) {
            state.history.unshift(entry);
            this.save();
            this.render();
        },

        remove(id) {
            state.history = state.history.filter((e) => e.id !== id);
            this.save();
            this.render();
        },

        clear() {
            state.history = [];
            this.save();
            this.render();
        },

        render(filter = "") {
            const list = $("#historyList");
            const empty = $("#historyEmpty");
            const filterLower = filter.trim().toLowerCase();

            const filtered = filterLower
                ? state.history.filter(
                      (e) =>
                          e.url.toLowerCase().includes(filterLower) ||
                          e.method.toLowerCase().includes(filterLower)
                  )
                : state.history;

            list.innerHTML = "";

            if (filtered.length === 0) {
                empty.classList.add("is-visible");
                empty.querySelector("p").innerHTML = filterLower
                    ? "No matching requests."
                    : "No requests yet.<br/>Send your first request to see it here.";
                return;
            }

            empty.classList.remove("is-visible");

            filtered.forEach((entry) => {
                const li = document.createElement("li");
                li.className = "history-item";
                li.dataset.id = entry.id;

                const methodColor = `var(--m-${entry.method.toLowerCase()})`;
                const statusInfo = entry.error
                    ? `<span class="history-item__status" style="color: var(--s-5xx)">ERR</span>`
                    : entry.status
                    ? `<span class="history-item__status" style="color: var(--s-${
                          Math.floor(entry.status / 100)
                      }xx)">${entry.status}</span>`
                    : "";

                li.innerHTML = `
                    <div class="history-item__top">
                        <span class="history-item__method" style="color: ${methodColor}">${
                    entry.method
                }</span>
                        <span class="history-item__url" title="${escapeHTML(
                            entry.url
                        )}">${escapeHTML(entry.url)}</span>
                    </div>
                    <div class="history-item__meta">
                        ${statusInfo}
                        <span>${
                            entry.duration != null ? entry.duration + " ms" : ""
                        }</span>
                        <span>${formatRelativeTime(entry.timestamp)}</span>
                    </div>
                    <button class="history-item__delete" title="Delete" aria-label="Delete">
                        <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
                            <path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M6 6l12 12M6 18L18 6"/>
                        </svg>
                    </button>
                `;

                li.addEventListener("click", (e) => {
                    if (e.target.closest(".history-item__delete")) return;
                    this.loadEntry(entry);
                });

                li.querySelector(".history-item__delete").addEventListener(
                    "click",
                    (e) => {
                        e.stopPropagation();
                        this.remove(entry.id);
                    }
                );

                list.appendChild(li);
            });
        },

        loadEntry(entry) {
            // Restore method + URL
            const select = $("#methodSelect");
            select.value = entry.method;
            select.dataset.method = entry.method;
            $("#urlInput").value = entry.rawUrl || entry.url;

            // Restore KV editors
            state.kv.params = clone(entry.params) || [
                { key: "", value: "", enabled: true },
            ];
            state.kv.headers = clone(entry.headers) || [
                { key: "", value: "", enabled: true },
            ];
            state.kv.formData = clone(entry.formData) || [
                { key: "", value: "", enabled: true },
            ];
            state.kv.urlEncoded = clone(entry.urlEncoded) || [
                { key: "", value: "", enabled: true },
            ];

            // Restore body type + JSON
            state.bodyType = entry.bodyType || "none";
            state.bodyJson = entry.bodyJson || "";
            const jsonInput = $("#bodyJsonInput");
            jsonInput.value = state.bodyJson;
            // Fire input so validity hint + auto-resize refresh
            jsonInput.dispatchEvent(new Event("input"));
            const radio = $(`input[name="bodyType"][value="${state.bodyType}"]`);
            if (radio) {
                radio.checked = true;
                radio.dispatchEvent(new Event("change"));
            }

            KV.renderAll();
            Toast.show("Request loaded", "info", 1500);

            // Auto-close mobile sidebar
            $("#sidebar").classList.remove("is-open");
        },
    };

    function clone(x) {
        return x == null ? x : JSON.parse(JSON.stringify(x));
    }

    function formatRelativeTime(timestamp) {
        const diff = Date.now() - timestamp;
        const sec = Math.round(diff / 1000);
        if (sec < 60) return "just now";
        const min = Math.round(sec / 60);
        if (min < 60) return `${min}m ago`;
        const hr = Math.round(min / 60);
        if (hr < 24) return `${hr}h ago`;
        const days = Math.round(hr / 24);
        if (days < 30) return `${days}d ago`;
        return new Date(timestamp).toLocaleDateString();
    }

    /* ----------------------------------------------------------
       Save the current request as a history entry
       ---------------------------------------------------------- */
    function saveHistoryEntry(req, result) {
        const entry = {
            id: crypto.randomUUID
                ? crypto.randomUUID()
                : String(Date.now()) + Math.random().toString(36).slice(2),
            timestamp: Date.now(),
            method: req.method,
            url: req.url,
            rawUrl: $("#urlInput").value.trim(),
            params: clone(state.kv.params),
            headers: clone(state.kv.headers),
            formData: clone(state.kv.formData),
            urlEncoded: clone(state.kv.urlEncoded),
            bodyType: state.bodyType,
            bodyJson: state.bodyJson,
            ...result,
        };
        History.add(entry);
    }

    /* ----------------------------------------------------------
       Copy helpers
       ---------------------------------------------------------- */
    async function copyToClipboard(text) {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch {
            // Fallback for older browsers / insecure contexts
            const ta = document.createElement("textarea");
            ta.value = text;
            ta.style.position = "fixed";
            ta.style.opacity = "0";
            document.body.appendChild(ta);
            ta.select();
            try {
                document.execCommand("copy");
                document.body.removeChild(ta);
                return true;
            } catch {
                document.body.removeChild(ta);
                return false;
            }
        }
    }

    /* ----------------------------------------------------------
       Import / export
       ---------------------------------------------------------- */
    function exportHistory() {
        const payload = {
            exportedAt: new Date().toISOString(),
            tool: "Pulse API Client",
            version: 1,
            variables: state.kv.variables,
            history: state.history,
        };
        const blob = new Blob([JSON.stringify(payload, null, 2)], {
            type: "application/json",
        });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `pulse-export-${new Date()
            .toISOString()
            .replace(/[:.]/g, "-")}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        Toast.show("Exported requests", "success");
    }

    function importHistory(file) {
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const data = JSON.parse(e.target.result);
                if (Array.isArray(data.history)) {
                    state.history = [...data.history, ...state.history].slice(
                        0,
                        HISTORY_LIMIT
                    );
                    History.save();
                    History.render();
                }
                if (Array.isArray(data.variables)) {
                    state.kv.variables = data.variables;
                    KV.persistVariables();
                    KV.render("variables");
                    KV.updateEnvIndicator();
                }
                Toast.show("Import successful", "success");
            } catch (err) {
                Toast.show("Invalid file: " + err.message, "error");
            }
        };
        reader.readAsText(file);
    }

    /* ----------------------------------------------------------
       Wire up everything
       ---------------------------------------------------------- */
    function setupEventListeners() {
        $("#sendBtn").addEventListener("click", sendRequest);

        // Ctrl/Cmd+Enter from anywhere sends the request
        document.addEventListener("keydown", (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                e.preventDefault();
                sendRequest();
            }
        });

        // "Add row" buttons
        $$(".kv-add").forEach((btn) => {
            btn.addEventListener("click", () => {
                const kind = btn.dataset.add;
                state.kv[kind].push({ key: "", value: "", enabled: true });
                KV.render(kind);
            });
        });

        // History search
        $("#historySearch").addEventListener("input", (e) => {
            History.render(e.target.value);
        });

        // Clear history
        $("#clearHistoryBtn").addEventListener("click", () => {
            if (state.history.length === 0) return;
            if (confirm("Clear all request history? This cannot be undone.")) {
                History.clear();
                Toast.show("History cleared", "info");
            }
        });

        // Copy response
        $("#copyResponseBtn").addEventListener("click", async () => {
            if (!state.lastResponse) {
                Toast.show("Nothing to copy yet", "info");
                return;
            }
            const ok = await copyToClipboard(state.lastResponse.text);
            Toast.show(ok ? "Response copied" : "Copy failed", ok ? "success" : "error");
        });

        // Copy curl
        $("#copyCurlBtn").addEventListener("click", async () => {
            const text = $("#curlPreview").textContent.trim();
            if (!text || text === "cURL command will appear here.") {
                Toast.show("Send a request first", "info");
                return;
            }
            const ok = await copyToClipboard(text);
            Toast.show(ok ? "cURL copied" : "Copy failed", ok ? "success" : "error");
        });

        // Wrap toggle
        const wrapBtn = $("#wrapToggleBtn");
        const applyWrap = (on) => {
            $("#responseBody").classList.toggle("wrap", on);
            store.set(STORAGE.WRAP, on);
        };
        wrapBtn.addEventListener("click", () => {
            const on = !$("#responseBody").classList.contains("wrap");
            applyWrap(on);
        });
        applyWrap(!!store.get(STORAGE.WRAP));

        // Import / export
        $("#exportBtn").addEventListener("click", exportHistory);
        $("#importBtn").addEventListener("click", () =>
            $("#importInput").click()
        );
        $("#importInput").addEventListener("change", (e) => {
            const file = e.target.files[0];
            if (file) importHistory(file);
            e.target.value = "";
        });

        // Variables button: jump to the Variables tab
        $("#envBtn").addEventListener("click", () => {
            $('.tab[data-tab="variables"]').click();
        });

        // Mobile sidebar toggle
        $("#sidebarToggle").addEventListener("click", () => {
            $("#sidebar").classList.toggle("is-open");
        });

        // Auto-resize JSON editor
        const jsonInput = $("#bodyJsonInput");
        const autoResize = () => {
            jsonInput.style.height = "auto";
            jsonInput.style.height =
                Math.min(jsonInput.scrollHeight + 2, 320) + "px";
        };
        jsonInput.addEventListener("input", autoResize);
    }

    /* ----------------------------------------------------------
       Boot
       ---------------------------------------------------------- */
    function init() {
        Theme.init();
        Settings.load();
        Settings.bind();
        KV.loadVariables();
        KV.renderAll();
        KV.updateEnvIndicator();
        setupTabs();
        setupBodyType();
        setupMethodSelect();
        setupEventListeners();
        History.load();

        // Silently test proxy connectivity in the background on first load
        // so the cascade already knows which are reachable before the user
        // sends their first request. Re-check if last check was > 6 hours ago.
        const lastCheck = store.get("pulse.lastProxyCheck", 0);
        const SIX_HOURS = 6 * 60 * 60 * 1000;
        if (Date.now() - lastCheck > SIX_HOURS) {
            setTimeout(() => silentProxyCheck(), 1500);
        }

        // Helpful first-run sample so the app isn't intimidating when empty
        if (state.history.length === 0 && !$("#urlInput").value) {
            $("#urlInput").value = "https://jsonplaceholder.typicode.com/todos/1";
        }
    }

    /* ----------------------------------------------------------
       Silent background proxy connectivity check.
       Runs on first load (and every 6h) to pre-populate the
       reachableProxies list so the cascade is faster.
       ---------------------------------------------------------- */
    async function silentProxyCheck() {
        const results = [];
        const checks = PROXY_PROVIDERS.map(async (provider) => {
            try {
                const ctrl = new AbortController();
                const timeout = setTimeout(() => ctrl.abort(), 5000);
                const resp = await fetch(provider.testUrl, {
                    method: "GET",
                    signal: ctrl.signal,
                });
                clearTimeout(timeout);
                if (resp.ok) results.push(provider.id);
            } catch {
                /* unreachable */
            }
        });
        await Promise.allSettled(checks);

        state.settings.reachableProxies = results;
        Settings.save();
        store.set("pulse.lastProxyCheck", Date.now());
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
