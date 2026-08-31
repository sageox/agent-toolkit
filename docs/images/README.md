# Generated images

`architecture.png` is a render of `../design/2026-08-12-multi-surface-agent-toolkit-arch.html`,
embedded at the top of the repo README.

Regenerate it after editing that HTML:

```sh
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless --disable-gpu --hide-scrollbars --force-device-scale-factor=2 \
  --window-size=1280,1700 \
  --screenshot="$(pwd)/docs/images/architecture.png" \
  "file://$(pwd)/docs/design/2026-08-12-multi-surface-agent-toolkit-arch.html"
```

The window height is set to the content height — too tall leaves dead space in the
image, too short crops the flow section. Check the result before committing.
