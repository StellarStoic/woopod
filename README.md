# woopod public website

Static, buildless project homepage and current-feature documentation for GitHub Pages. It makes no external font, analytics, advertising, image or JavaScript request.

## Preview locally

From this directory:

```sh
python3 -m http.server 8080
```

Open `http://localhost:8080/`.

## Publish with GitHub Pages

Use this directory as the root of a **separate public repository**. In GitHub, open **Settings → Pages**, select **Deploy from a branch**, choose the default branch and `/ (root)`. The `.nojekyll` file prevents Jekyll processing.

Do not copy Android source, private build inputs, signing material, device logs or internal development documents into the public website repository. Copy only explicitly approved screenshots, release APK links, public documentation and brand assets.

## Content status

The page distinguishes **Available**, **Partial**, and **Roadmap** capabilities. Update those labels alongside public app releases. The current page describes the Android `0.16.2-preview` implementation and its recorded roadmap; it does not provide an APK download or claim a production release.

## Files

- `index.html` — semantic page content, documentation and inline SVG icon sprite
- `styles.css` — responsive presentation and reduced-motion behavior
- `app.js` — parallax, reveal, navigation, documentation search, color and font demos
- `assets/` — supplied woopod brand images
- `manifest.webmanifest`, favicon files and `.nojekyll` — browser/GitHub Pages metadata
