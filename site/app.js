const WORKBENCH_MODES = {
  inspect: {
    caption: 'Focus-emulated session over Named Pipe / Unix socket',
    tabTitle: 'Staging Billing Dashboard',
    tabUrl: 'https://staging.example.com/billing',
    terminal: [
      '$ latch tabs',
      'Tabs (2) [profile: work]:',
      '  [49904730] Staging Billing Dashboard — https://staging.example.com/billing (active)',
      '  [49904742] Docs — https://example.com/docs',
      '',
      '$ latch connect 49904730',
      'Session "s-37a21b" connected (tab 49904730, profile work, focus-emulation on)',
      '',
      '$ latch snapshot',
      'Snapshot: Staging Billing Dashboard [18 refs]',
      '- heading "Billing & Plan" [level=1] [ref=e1]',
      '- textbox "Billing email" [ref=e2]',
      '- button "Save settings" [ref=e3]',
    ].join('\n'),
    browserItems: [
      {label: 'Profile alias', detail: 'work (paired over com.latch.bridge)'},
      {label: 'Active session', detail: 's-37a21b bound under <appDataDir>/sessions/'},
      {label: 'Ref map', detail: 'e1 heading, e2 textbox, e3 button ("Save settings")'},
    ],
  },
  record: {
    caption: 'Opt-in filmstrip captures before/after PNGs on every step',
    tabTitle: 'Checkout · Order #8492',
    tabUrl: 'https://staging.example.com/checkout',
    terminal: [
      '$ latch open https://staging.example.com/checkout --record --objective "Verify checkout validation"',
      'Session "s-81f04d" connected (tab 49904801, focus-emulation on)',
      'Recording run: c4125ce0-adf1-4a3a-9f5c-d53c0f5e0850',
      '',
      '$ latch click e4',
      'OK (click) — Checkout (https://staging.example.com/checkout)',
      '',
      '$ latch checkpoint "Empty submit displays inline validation banner"',
      'Checkpoint recorded (run c4125ce0-adf1-4a3a-9f5c-d53c0f5e0850).',
      '',
      '$ latch finish',
      'Finished exploration c4125ce0-adf1-4a3a-9f5c-d53c0f5e0850 (complete)',
    ].join('\n'),
    browserItems: [
      {label: 'Before screenshot', detail: 'screenshots/state-00001.png (SHA-256 verified)'},
      {label: 'After screenshot', detail: 'screenshots/state-00002.png (SHA-256 verified)'},
      {label: 'Locator candidates', detail: 'role=button[name="Pay now"], data-testid="submit-order"'},
    ],
  },
  review: {
    caption: 'Local 127.0.0.1 reviewer with custom storage and safe cleanup',
    tabTitle: 'Latch Exploration Library (127.0.0.1)',
    tabUrl: 'http://127.0.0.1:61103/run/c4125ce0-adf1-4a3a-9f5c-d53c0f5e0850',
    terminal: [
      '$ latch library serve',
      '{"localLibrary":"http://127.0.0.1:61103","localOnly":true}',
      '',
      '$ latch library review c4125ce0 --decision automate --note "Add validation spec"',
      'Saved review (automate) for c4125ce0.',
      '',
      '$ latch config set artifacts-dir D:\\LatchRuns',
      'Saved artifacts folder: D:\\LatchRuns [config]',
      '',
      '$ latch library delete c4125ce0',
      'Deleted exploration c4125ce0.',
    ].join('\n'),
    browserItems: [
      {label: 'Extension popup', detail: 'Open Library, View run, Stop session, Choose folder…'},
      {label: 'QA decision', detail: 'Saved in review.json separately from immutable artifacts'},
      {label: 'Tab cleanup', detail: 'Confirmed: website tabs and logins remain untouched'},
    ],
  },
};

const INSTALL_MATRIX = {
  npm: {
    win: {
      note: 'Install @mihaamiharu/latch globally, register com.latch.bridge, and link agent plugins.',
      cmd: '$env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1"; npm install -g @mihaamiharu/latch\nlatch install',
    },
    unix: {
      note: 'Install @mihaamiharu/latch globally, register com.latch.bridge, and link agent plugins.',
      cmd: 'PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install -g @mihaamiharu/latch\nlatch install',
    },
  },
  kit: {
    win: {
      note: 'Download latch-1.0.0-kit.zip from GitHub Releases, extract to a permanent folder, then run install.',
      cmd: 'cd C:\\Tools\\latch-1.0.0\nnode src/cli.mjs install',
    },
    unix: {
      note: 'Download latch-1.0.0-kit.zip from GitHub Releases, extract to a permanent folder, then run install.',
      cmd: 'cd ~/Tools/latch-1.0.0\nnode src/cli.mjs install',
    },
  },
  git: {
    win: {
      note: 'Clone the repository, install dependencies without browser downloads, register host, and link latch globally.',
      cmd: 'git clone https://github.com/mihaamiharu/Latch.git\ncd Latch\n$env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1"; npm ci\nnode src/cli.mjs install\nnpm link',
    },
    unix: {
      note: 'Clone the repository, install dependencies without browser downloads, register host, and link latch globally.',
      cmd: 'git clone https://github.com/mihaamiharu/Latch.git\ncd Latch\nPLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci\nnode src/cli.mjs install\nnpm link',
    },
  },
};

const FILMSTRIP_STEPS = [
  {
    meta: 'Step 1 of 3 · goto /checkout · 2 PNG states',
    beforeTitle: 'New tab (about:blank)',
    beforeDesc: 'Session s-81f04d initialized with focus emulation enabled.',
    afterTitle: 'Checkout form loaded',
    afterDesc: 'Captured state-00001.png and initial 42-ref ARIA tree before inputs.',
    locators: 'textbox "Email" (id="email"), checkbox "Terms", button "Pay now" (data-testid="submit-order")',
  },
  {
    meta: 'Step 2 of 3 · fill e2 "qa@example.com" · succeeded',
    beforeTitle: 'Empty Email field (state-00001.png)',
    beforeDesc: 'Email input empty; Submit disabled state captured in before snapshot.',
    afterTitle: 'Email populated (state-00002.png)',
    afterDesc: 'Synthetic test input typed cleanly in background tab without stealing focus.',
    locators: 'getByRole("textbox", { name: "Email" }) confirmed unique on main frame',
  },
  {
    meta: 'Step 3 of 3 · click e3 + checkpoint · finished',
    beforeTitle: 'Ready to submit (state-00002.png)',
    beforeDesc: 'Form state immediately before triggering click e3.',
    afterTitle: 'Validation banner visible (state-00003.png)',
    afterDesc: 'Checkpoint saved finding; exploration.yaml and exploration.json verified by SHA-256.',
    locators: 'role="alert" text="Card number is required", button "Pay now" remains enabled',
  },
];

const COMMAND_GROUPS = {
  lifecycle: [
    ['latch tabs', 'List open Chrome tabs with IDs, titles, URLs, and current session ownership'],
    ['latch open <url> [--record] [--objective <text>]', 'Open a new tab, attach a session, and optionally record a filmstrip exploration'],
    ['latch connect <tabId> [--record] [--objective <text>]', 'Attach to an existing signed-in Chrome tab while preserving session cookies'],
    ['latch sessions', 'Show active Latch sessions bound in the current paired Chrome profile'],
    ['latch release [tabId]', 'Detach debugger from one tab while keeping the browser tab open'],
    ['latch disconnect', 'Close the active Latch session and preserve all tabs and logins'],
    ['latch finish', 'Finalize a recorded exploration, write handoff YAML/JSON, and disconnect'],
  ],
  actions: [
    ['latch snapshot [selector] [--depth N]', 'Capture ARIA snapshot with interactive refs (large trees >12 KB spill to disk)'],
    ['latch click <ref|selector> / dblclick / hover', 'Click, double-click, or hover elements using fresh refs or CSS/ARIA selectors'],
    ['latch fill <ref|selector> <value> / type / press', 'Fill inputs, type text cleanly, or dispatch keyboard keys'],
    ['latch select / check / uncheck / upload', 'Control checkboxes, select dropdowns, and upload local files'],
    ['latch screenshot [ref|selector] [--out <path>] [--full-page]', 'Save a PNG screenshot locally or of a single element'],
    ['latch goto <url> / back / forward / reload', 'Navigate within the attached tab (HTTP/HTTPS URLs only)'],
    ['latch eval <expr> / run-code <fn>', 'Evaluate expressions or run Playwright code in the active page'],
    ['latch console [level] / network [filter] / dialog <accept|dismiss>', 'Inspect console/network logs (secrets redacted) and handle browser dialogs'],
  ],
  library: [
    ['latch checkpoint <note> [--annotation-file <path>]', 'Record structured agent observations linked to the current state'],
    ['latch library list / show <runId>', 'List recorded explorations or inspect handoff, integrity, and review status'],
    ['latch library serve [--port N]', 'Start the local 127.0.0.1 interactive filmstrip and QA reviewer'],
    ['latch library review <runId> --decision <d> [--note <text>]', 'Save QA triage decision (automate, investigate, report_bug, closed)'],
    ['latch library export <runId> --destination <dir>', 'Copy hash-verified YAML, JSON, screenshots, and review into a new folder'],
    ['latch library delete <runId> | --all', 'Safely delete inactive runs while refusing active or locked explorations'],
    ['latch config get | set artifacts-dir <path> | unset artifacts-dir', 'Inspect, customize, or reset the Exploration Library storage path'],
  ],
  setup: [
    ['latch install', 'Register native host com.latch.bridge, create CLI launcher, link agent skills'],
    ['latch pair [--profile <alias>]', 'Auto-discover a live unpaired Chrome extension instance and save pairing'],
    ['latch doctor [--fix]', 'Verify Node, registration, and live bridge health; repair stale bindings'],
    ['latch agents <install|status|uninstall> [--target ...]', 'Manage integrations for Antigravity, Claude Code, Codex, and Cursor'],
    ['latch discover / diagnose / version / help', 'Inspect live endpoints, diagnostic layers, bundled playwright-core version'],
    ['latch uninstall', 'Unregister native messaging host and launchers while keeping config and library'],
  ],
};

let currentSource = 'npm';
let currentOs = navigator.platform?.toLowerCase().includes('win') ? 'win' : 'unix';

function renderWorkbench(modeKey) {
  const mode = WORKBENCH_MODES[modeKey] || WORKBENCH_MODES.inspect;
  document.getElementById('wb-caption').textContent = mode.caption;
  document.getElementById('wb-terminal').textContent = mode.terminal;
  document.getElementById('wb-tab-title').textContent = mode.tabTitle;
  document.getElementById('wb-tab-url').textContent = mode.tabUrl;

  const ul = document.createElement('ul');
  for (const item of mode.browserItems) {
    const li = document.createElement('li');
    const strong = document.createElement('strong');
    strong.textContent = item.label + ': ';
    li.append(strong, document.createTextNode(item.detail));
    ul.append(li);
  }
  document.getElementById('wb-browser-body').replaceChildren(ul);
}

function renderInstall() {
  const entry = INSTALL_MATRIX[currentSource]?.[currentOs] || INSTALL_MATRIX.npm.win;
  document.getElementById('step1-note').textContent = entry.note;
  document.getElementById('step1-cmd').textContent = entry.cmd;
}

function renderFilmstep(index) {
  const step = FILMSTRIP_STEPS[index] || FILMSTRIP_STEPS[0];
  document.getElementById('film-meta').textContent = step.meta;
  document.getElementById('film-locators').textContent = step.locators;

  const before = document.getElementById('film-before');
  const bTitle = document.createElement('strong');
  bTitle.textContent = step.beforeTitle;
  before.replaceChildren(bTitle, document.createTextNode(step.beforeDesc));

  const after = document.getElementById('film-after');
  const aTitle = document.createElement('strong');
  aTitle.textContent = step.afterTitle;
  after.replaceChildren(aTitle, document.createTextNode(step.afterDesc));
}

function renderCommandGroup(groupKey) {
  const rows = COMMAND_GROUPS[groupKey] || COMMAND_GROUPS.lifecycle;
  const tbody = document.getElementById('cmd-tbody');
  const fragment = document.createDocumentFragment();
  for (const [cmd, desc] of rows) {
    const tr = document.createElement('tr');
    const tdCmd = document.createElement('td');
    const code = document.createElement('code');
    code.textContent = cmd;
    tdCmd.append(code);
    const tdDesc = document.createElement('td');
    tdDesc.textContent = desc;
    tr.append(tdCmd, tdDesc);
    fragment.append(tr);
  }
  tbody.replaceChildren(fragment);
}

function wireTabGroup(selector, initialKey, onSelect) {
  const buttons = Array.from(document.querySelectorAll(selector));
  const activate = key => {
    for (const btn of buttons) {
      const value = btn.dataset.mode || btn.dataset.source || btn.dataset.os || btn.dataset.film || btn.dataset.cmdcat;
      btn.setAttribute('aria-selected', String(value === String(key)));
    }
    onSelect(key);
  };
  for (const btn of buttons) {
    btn.addEventListener('click', () => {
      const value = btn.dataset.mode || btn.dataset.source || btn.dataset.os || btn.dataset.film || btn.dataset.cmdcat;
      activate(value);
    });
  }
  activate(initialKey);
}

wireTabGroup('[data-mode]', 'inspect', renderWorkbench);
wireTabGroup('[data-source]', currentSource, source => {
  currentSource = source;
  renderInstall();
});
wireTabGroup('[data-os]', currentOs, osKey => {
  currentOs = osKey;
  renderInstall();
});
wireTabGroup('[data-film]', '0', idx => renderFilmstep(Number(idx)));
wireTabGroup('[data-cmdcat]', 'lifecycle', renderCommandGroup);

for (const btn of document.querySelectorAll('[data-copy-target]')) {
  btn.addEventListener('click', async () => {
    const target = document.getElementById(btn.dataset.copyTarget);
    if (!target) return;
    try {
      await navigator.clipboard.writeText(target.textContent || '');
      const original = btn.textContent;
      btn.textContent = 'Copied';
      setTimeout(() => {
        btn.textContent = original;
      }, 1500);
    } catch {
      btn.textContent = 'Select manually';
    }
  });
}

const header = document.getElementById('top-header');
const updateHeader = () => header.classList.toggle('scrolled', window.scrollY > 16);
window.addEventListener('scroll', updateHeader, {passive: true});
updateHeader();
