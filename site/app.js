const WORKBENCH_MODES = {
  inspect: {
    caption: 'Runs in a background tab without stealing your cursor or exposing your other tabs.',
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
      {label: 'Profile alias', detail: 'work (paired local Chrome profile)'},
      {label: 'Active session', detail: 's-37a21b bound under OS app data (zero repo dotfiles)'},
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
      note: 'Install @mihaamiharu/latch globally, register the local Chrome bridge, and link agent integrations.',
      cmd: 'npm install -g @mihaamiharu/latch\nlatch install',
    },
    unix: {
      note: 'Install @mihaamiharu/latch globally, register the local Chrome bridge, and link agent integrations.',
      cmd: 'npm install -g @mihaamiharu/latch\nlatch install',
    },
  },
  kit: {
    win: {
      note: 'Download latch-1.1.0-kit.zip from GitHub Releases, extract to a permanent folder, then run install.',
      cmd: 'cd C:\\Tools\\latch-1.1.0\nnode src/cli.mjs install',
    },
    unix: {
      note: 'Download latch-1.1.0-kit.zip from GitHub Releases, extract to a permanent folder, then run install.',
      cmd: 'cd ~/Tools/latch-1.1.0\nnode src/cli.mjs install',
    },
  },
  git: {
    win: {
      note: 'Clone the repository, install dependencies, register the local bridge, and link latch globally.',
      cmd: 'git clone https://github.com/mihaamiharu/Latch.git\ncd Latch\nnpm ci\nnode src/cli.mjs install\nnpm link',
    },
    unix: {
      note: 'Clone the repository, install dependencies, register the local bridge, and link latch globally.',
      cmd: 'git clone https://github.com/mihaamiharu/Latch.git\ncd Latch\nnpm ci\nnode src/cli.mjs install\nnpm link',
    },
  },
};

const FILMSTRIP_STEPS = [
  {
    meta: 'Step 1 of 2 · fill e2 "qa@acme-corp.internal" · succeeded',
    before: {
      title: 'Empty checkout form (state-00001.png)',
      desc: 'Signed-in staging tab attached before running latch fill e2.',
      img: 'assets/film-state-1.png',
      alt: 'Staging checkout page before filling the billing email field',
    },
    after: {
      title: 'Billing email populated (state-00002.png)',
      desc: 'Input typed cleanly in a background tab without stealing window focus.',
      img: 'assets/film-state-2.png',
      alt: 'Staging checkout page with billing email populated',
    },
    locators: 'getByRole("textbox", { name: "Billing email" }) confirmed unique on main frame',
  },
  {
    meta: 'Step 2 of 2 · click e5 ("Pay now") + checkpoint · finished',
    before: {
      title: 'Ready to submit (state-00002.png)',
      desc: 'Form state immediately before clicking Pay now with an empty card field.',
      img: 'assets/film-state-2.png',
      alt: 'Staging checkout page immediately before clicking Pay now',
    },
    after: {
      title: 'Validation alert visible (state-00003.png)',
      desc: 'Checkpoint logs what the agent observed without fabricating assertions—verify the real state in seconds.',
      img: 'assets/film-state-3.png',
      alt: 'Staging checkout page displaying inline card number required alert',
    },
    locators: 'role="alert" ("Card number is required before submitting order #8492."), button "Pay now" (data-testid="submit-order")',
  },
];

const COMMAND_GROUPS = {
  lifecycle: [
    ['latch tabs', 'List open Chrome tabs with IDs, titles, URLs, and current session ownership'],
    ['latch open <url> [--record] [--objective <text>]', 'Open a new tab inside a per-session Latch · <session> Chrome tab group and optionally record a filmstrip'],
    ['latch connect [tabId] [--record] [--objective <text>]', 'Attach to an existing signed-in tab (or an unowned Latch-grouped tab when tabId is omitted)'],
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

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
let currentSource = 'npm';
let currentOs = navigator.platform?.toLowerCase().includes('win') ? 'win' : 'unix';

function renderWorkbench(modeKey) {
  const mode = WORKBENCH_MODES[modeKey] || WORKBENCH_MODES.inspect;
  document.getElementById('wb-caption').textContent = mode.caption;
  document.getElementById('wb-tab-title').textContent = mode.tabTitle;
  document.getElementById('wb-tab-url').textContent = mode.tabUrl;

  const terminalEl = document.getElementById('wb-terminal');
  const lines = mode.terminal.split('\n');
  const termFrag = document.createDocumentFragment();
  lines.forEach((line, idx) => {
    const span = document.createElement('span');
    span.className = line.startsWith('$ ') ? 'cli-line is-cmd' : 'cli-line';
    span.style.setProperty('--line-delay', `${Math.min(idx * 28, 280)}ms`);
    span.textContent = line;
    if (idx === lines.length - 1) {
      const cursor = document.createElement('span');
      cursor.className = 'cli-cursor';
      cursor.setAttribute('aria-hidden', 'true');
      span.append(cursor);
    }
    termFrag.append(span);
  });
  terminalEl.replaceChildren(termFrag);

  const ul = document.createElement('ul');
  mode.browserItems.forEach((item, idx) => {
    const li = document.createElement('li');
    li.className = 'wb-item';
    li.style.setProperty('--line-delay', `${idx * 60 + 40}ms`);
    const strong = document.createElement('strong');
    strong.textContent = item.label + ': ';
    li.append(strong, document.createTextNode(item.detail));
    ul.append(li);
  });
  document.getElementById('wb-browser-body').replaceChildren(ul);
}

function renderInstall() {
  const entry = INSTALL_MATRIX[currentSource]?.[currentOs] || INSTALL_MATRIX.npm.win;
  document.getElementById('step1-note').textContent = entry.note;
  document.getElementById('step1-cmd').textContent = entry.cmd;
}

function buildShotPreview(el, shot) {
  const clone = el.cloneNode(false);
  const title = document.createElement('strong');
  title.textContent = shot.title;

  const desc = document.createElement('p');
  desc.className = 'shot-caption';
  desc.textContent = shot.desc;

  const img = document.createElement('img');
  img.className = 'shot-img';
  img.src = shot.img;
  img.alt = shot.alt;
  img.loading = 'lazy';

  clone.append(title, desc, img);
  el.replaceWith(clone);
}

function renderFilmstep(index) {
  const step = FILMSTRIP_STEPS[index] || FILMSTRIP_STEPS[0];
  document.getElementById('film-meta').textContent = step.meta;
  document.getElementById('film-locators').textContent = step.locators;
  buildShotPreview(document.getElementById('film-before'), step.before);
  buildShotPreview(document.getElementById('film-after'), step.after);
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
  const container = buttons[0]?.closest('.segmented');
  let indicator = null;
  if (container && !reducedMotion) {
    indicator = document.createElement('span');
    indicator.className = 'seg-indicator';
    indicator.setAttribute('aria-hidden', 'true');
    container.prepend(indicator);
  } else if (container) {
    container.classList.add('no-indicator');
  }

  const positionIndicator = () => {
    if (!indicator) return;
    const active = buttons.find(b => b.getAttribute('aria-selected') === 'true');
    if (!active || active.offsetWidth === 0) return;
    indicator.style.width = `${active.offsetWidth}px`;
    indicator.style.height = `${active.offsetHeight}px`;
    indicator.style.transform = `translate3d(${active.offsetLeft}px, ${active.offsetTop}px, 0)`;
  };

  const activate = key => {
    for (const btn of buttons) {
      const value = btn.dataset.mode || btn.dataset.source || btn.dataset.os || btn.dataset.film || btn.dataset.cmdcat;
      btn.setAttribute('aria-selected', String(value === String(key)));
    }
    onSelect(key);
    requestAnimationFrame(positionIndicator);
  };

  for (const btn of buttons) {
    btn.addEventListener('click', () => {
      const value = btn.dataset.mode || btn.dataset.source || btn.dataset.os || btn.dataset.film || btn.dataset.cmdcat;
      activate(value);
    });
  }

  if (container && indicator && 'ResizeObserver' in window) {
    new ResizeObserver(positionIndicator).observe(container);
  } else {
    window.addEventListener('resize', positionIndicator, {passive: true});
  }
  if (document.fonts?.ready) {
    void document.fonts.ready.then(positionIndicator);
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

// Header elevation + scroll progress bar + catch-up reveals for anchor jumps
const header = document.getElementById('top-header');
const revealEls = Array.from(document.querySelectorAll('[data-reveal]'));
let revealObserver = null;
let scrollScheduled = false;

function revealVisibleAndAbove() {
  if (!document.documentElement.classList.contains('js-motion')) return;
  let batch = 0;
  for (const el of revealEls) {
    if (el.classList.contains('is-visible')) continue;
    const rect = el.getBoundingClientRect();
    if (rect.top < window.innerHeight * 0.96) {
      el.style.setProperty('--reveal-delay', `${Math.min(batch * 55, 220)}ms`);
      el.classList.add('is-visible');
      revealObserver?.unobserve(el);
      batch++;
    }
  }
}

function syncScrollUI() {
  scrollScheduled = false;
  const maxScroll = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
  const progress = Math.min(1, Math.max(0, window.scrollY / maxScroll));
  header.classList.toggle('scrolled', window.scrollY > 16);
  document.documentElement.style.setProperty('--scroll-progress', progress.toFixed(4));
  revealVisibleAndAbove();
}
window.addEventListener(
  'scroll',
  () => {
    if (!scrollScheduled) {
      scrollScheduled = true;
      requestAnimationFrame(syncScrollUI);
    }
  },
  {passive: true},
);

// Progressive scroll-reveal choreography
if (!reducedMotion && 'IntersectionObserver' in window && revealEls.length) {
  document.documentElement.classList.add('js-motion');
  revealObserver = new IntersectionObserver(
    entries => {
      let batch = 0;
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.style.setProperty('--reveal-delay', `${Math.min(batch * 55, 220)}ms`);
        entry.target.classList.add('is-visible');
        revealObserver.unobserve(entry.target);
        batch++;
      }
    },
    {threshold: 0.08, rootMargin: '0px 0px -30px 0px'},
  );
  for (const el of revealEls) {
    const rect = el.getBoundingClientRect();
    if (rect.top < window.innerHeight * 0.92) {
      el.classList.add('is-visible');
    } else {
      revealObserver.observe(el);
    }
  }
}
syncScrollUI();

// Subtle pointer spotlight on hero
const hero = document.getElementById('hero-section');
if (hero && !reducedMotion) {
  let glowScheduled = false;
  let px = '50%';
  let py = '28%';
  hero.addEventListener(
    'pointermove',
    e => {
      if (e.pointerType !== 'mouse') return;
      const rect = hero.getBoundingClientRect();
      px = `${(((e.clientX - rect.left) / Math.max(1, rect.width)) * 100).toFixed(1)}%`;
      py = `${(((e.clientY - rect.top) / Math.max(1, rect.height)) * 100).toFixed(1)}%`;
      if (!glowScheduled) {
        glowScheduled = true;
        requestAnimationFrame(() => {
          glowScheduled = false;
          hero.style.setProperty('--mx', px);
          hero.style.setProperty('--my', py);
        });
      }
    },
    {passive: true},
  );
}
