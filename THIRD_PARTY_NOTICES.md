# Third-party notices

The complete Latch kit retains these notices and license files:

| Component | Included material | License |
| --- | --- | --- |
| `ws` 8.22.0 | The pinned JavaScript WebSocket dependency under `node_modules/ws/` | MIT; see `node_modules/ws/LICENSE` |
| Microsoft Playwright source | Adapted target/session mapping and initialization in `src/native-browser-model.mjs` | Apache-2.0; see `third_party/playwright/LICENSE` and `third_party/playwright/SOURCES.md` |

The Playwright provenance file records reference revision
`f9a841f968dd9a4e315df2ec2930da1952971667`, upstream files and local changes.
The installed Playwright CLI is unmodified and remains an external prerequisite;
it is not bundled into this kit. Node is also an external prerequisite. Their
distributions carry their own licenses/notices.

Latch's project license is separate from these third-party terms. The notices do
not choose a project license or grant rights on behalf of the Latch owner.
