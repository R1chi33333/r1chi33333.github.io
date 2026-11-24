# Credits

Microduck Lab is drawn in a comic-book style: the living room, furniture, floor, window view, walls, rug, ramp, garage and most toys are generated in code. The third-party assets below are the only ones it ships or loads. The glTF props were re-encoded for the web (meshes simplified and meshopt-compressed, textures resized to 1024/512 px and converted to WebP, rescaled to real-world size), and are recoloured at runtime into flat comic colours. Each re-encoded glTF keeps its attribution in `asset.copyright`.

## Robot

| Asset | Author | Source | Licence | Notes |
|---|---|---|---|---|
| Microduck robot | Pollen Robotics | [github.com/pollen-robotics/microduck_rl](https://github.com/pollen-robotics/microduck_rl) | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) | Assembled into an articulated rig with an added jaw joint (`microduck_rig.glb.txt`). Non-commercial use only. |

## Props (`assets/models/`)

| File | Asset | Author | Source | Licence |
|---|---|---|---|---|
| `toycar.glb` | Toy Car | Guido Odendahl and Eric Chadwick | [KhronosGroup/glTF-Sample-Assets: ToyCar](https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/ToyCar) | [CC0](https://creativecommons.org/publicdomain/zero/1.0/) |
| `pawn.glb`, `knight.glb` | A Beautiful Game (chess set), single pieces extracted | MaterialX Project and Ed Mackey | [KhronosGroup/glTF-Sample-Assets: ABeautifulGame](https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/ABeautifulGame) | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) |
| `cookie.glb` | Cookie (Food Kit) | Kenney | [pmndrs/market-assets: cookie](https://github.com/pmndrs/market-assets/tree/main/files/models/cookie) | CC0 |
| `toast.glb` | Bread (Food Kit) | Kenney | [pmndrs/market-assets: bread](https://github.com/pmndrs/market-assets/tree/main/files/models/bread) | CC0 |
| `croissant.glb` | Croissant (Food Kit) | Kenney | [pmndrs/market-assets: croissant](https://github.com/pmndrs/market-assets/tree/main/files/models/croissant) | CC0 |

## Font

| Asset | Author | Source | Licence |
|---|---|---|---|
| Bangers (comic UI and sound-effect stickers), bundled as `fonts/Bangers-Regular.woff2` (licence text in `fonts/Bangers-OFL.txt`) | Vernon Adams (The Bangers Project Authors) | [github.com/googlefonts/bangers](https://github.com/googlefonts/bangers) | [SIL Open Font License 1.1](https://openfontlicense.org) |

## Libraries

| Library | Licence | Source |
|---|---|---|
| three.js r160 (with GLTFLoader, EffectComposer, UnrealBloomPass and the meshopt decoder) | MIT | [github.com/mrdoob/three.js](https://github.com/mrdoob/three.js) |
| Rapier (`@dimforge/rapier3d-compat`) | Apache 2.0 | [github.com/dimforge/rapier](https://github.com/dimforge/rapier) |
