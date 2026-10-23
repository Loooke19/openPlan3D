# Third-party assets

Three.js 0.180.0, MIT license: `three/LICENSE`.
Original npm tarball: https://registry.npmjs.org/three/-/three-0.180.0.tgz
Vendored without modification: `build/three.module.js`, `build/three.core.js`, and `examples/jsm/controls/OrbitControls.js`.
Served locally, with no runtime CDN dependency.

## Ambient CSS

`@ambientcss/css` 3.0.1, MIT license: `ambientcss/LICENSE`.
Official package: https://registry.npmjs.org/@ambientcss/css/-/css-3.0.1.tgz
Original `dist/ambient.css` and package metadata are vendored without modification.
Used for the shared light environment, inset search surface, dimensional buttons, view selector and navigation tray. This is the real CSS package; the React component package is not currently imported.

## Tabler Icons

Tabler Icons 3.31.0, MIT license: `tabler-icons/LICENSE`.
A small outline subset is vendored for hospital facility marks (restroom, elevator, entrance, stairs, etc.).
See `tabler-icons/README.md`.
