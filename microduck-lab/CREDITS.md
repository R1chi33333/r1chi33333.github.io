# Credits

Microduck Lab uses the third-party assets listed below. All of them were downloaded from their GitHub mirrors and re-encoded for the web: meshes simplified and compressed with meshopt, textures resized to 1024 px (desktop) and 512 or 256 px (phone, `*.m.*` files) and converted to WebP, and models rescaled to real-world size in metres. Each re-encoded glTF keeps its attribution in `asset.copyright`.

## Robot

| Asset | Author | Source | Licence | Notes |
|---|---|---|---|---|
| Microduck robot | Pollen Robotics | [github.com/pollen-robotics/microduck_rl](https://github.com/pollen-robotics/microduck_rl) | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) | Assembled into an articulated rig with an added jaw joint (`microduck_rig.glb.txt`). Non-commercial use only. |

## Furniture and room dressing (`assets/models/`)

All of these come from the [KhronosGroup/glTF-Sample-Assets](https://github.com/KhronosGroup/glTF-Sample-Assets) repository.

| File | Asset | Author | Source | Licence |
|---|---|---|---|---|
| `sofa.glb` | Glam Velvet Sofa | Eric Chadwick (Wayfair model) | [Models/GlamVelvetSofa](https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/GlamVelvetSofa) | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) |
| `pouf.glb` | Specular Silk Pouf | Eric Chadwick (Wayfair model) | [Models/SpecularSilkPouf](https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/SpecularSilkPouf) | CC BY 4.0 |
| `plant.glb` | Diffuse Transmission Plant | Eric Chadwick; textures by Rico Cilliers | [Models/DiffuseTransmissionPlant](https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/DiffuseTransmissionPlant) | CC BY 4.0 (model); textures [CC0](https://creativecommons.org/publicdomain/zero/1.0/) |
| `vase.glb` | Glass Vase with Flowers | Eric Chadwick; textures by Rico Cilliers | [Models/GlassVaseFlowers](https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/GlassVaseFlowers) | CC0 |
| `teacup.glb` | Diffuse Transmission Teacup | Poly Haven and Eric Chadwick | [Models/DiffuseTransmissionTeacup](https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/DiffuseTransmissionTeacup) | CC0 |
| `boombox.glb` | Boom Box | Microsoft | [Models/BoomBox](https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/BoomBox) | CC0 |
| `cone.glb` | Traffic Cone (used as the race cones) | hinndia; textures by Rob Tuytel | [Models/TrafficCone](https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/TrafficCone) | CC BY 4.0 (model); textures CC0 |

## Toys and props (`assets/models/`)

| File | Asset | Author | Source | Licence |
|---|---|---|---|---|
| `toycar.glb` | Toy Car | Guido Odendahl and Eric Chadwick | [glTF-Sample-Assets/Models/ToyCar](https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/ToyCar) | CC0 |
| `wickerball.glb` | Clearcoat Wicker | Eric Chadwick | [glTF-Sample-Assets/Models/ClearcoatWicker](https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/ClearcoatWicker) | CC0 |
| `pawn.glb`, `knight.glb` | A Beautiful Game (chess set), single pieces extracted | MaterialX Project and Ed Mackey | [glTF-Sample-Assets/Models/ABeautifulGame](https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/ABeautifulGame) | CC BY 4.0 |
| `cookie.glb` | Cookie (Food Kit) | Kenney | [pmndrs/market-assets](https://github.com/pmndrs/market-assets/tree/main/files/models/cookie) | CC0 |
| `toast.glb` | Bread (Food Kit) | Kenney | [pmndrs/market-assets](https://github.com/pmndrs/market-assets/tree/main/files/models/bread) | CC0 |
| `croissant.glb` | Croissant (Food Kit) | Kenney | [pmndrs/market-assets](https://github.com/pmndrs/market-assets/tree/main/files/models/croissant) | CC0 |

The Kenney models were converted from unlit to lit PBR materials.

## Textures and lighting (`assets/textures/`)

| File | Asset | Author | Source | Licence |
|---|---|---|---|---|
| `floor_*.webp` | Wood Floor 043 (colour regraded to a lighter honey oak) | ambientCG | [ambientcg.com/view?id=WoodFloor043](https://ambientcg.com/view?id=WoodFloor043), via [pmndrs/market-assets](https://github.com/pmndrs/market-assets/tree/main/files/materials/wood-floor-43) | CC0 |
| `room_env.hdr` | St. Fagans Interior (downsampled to 256 × 128) | Morgan Evans / Poly Haven | [polyhaven.com/a/st_fagans_interior](https://polyhaven.com/a/st_fagans_interior), via [pmndrs/market-assets](https://github.com/pmndrs/market-assets/tree/main/files/hdris/st-fagans) | CC0 |
| `window_view*.jpg` | Forest Slope (tone-mapped for the window view) | Andreas Mischok / Poly Haven | [polyhaven.com/a/forest_slope](https://polyhaven.com/a/forest_slope), via [pmndrs/market-assets](https://github.com/pmndrs/market-assets/tree/main/files/hdris/forrest-slope) | CC0 |

The walls, window frame, baseboards, rug, oak table, coffee table, shelf, cardboard ramp, goals, garage mat and the remaining small toys are procedural and generated in code.

## Libraries

| Library | Licence | Source |
|---|---|---|
| three.js r160 (with GLTFLoader, RGBELoader and the meshopt decoder) | MIT | [github.com/mrdoob/three.js](https://github.com/mrdoob/three.js) |
| Rapier (`@dimforge/rapier3d-compat`) | Apache 2.0 | [github.com/dimforge/rapier](https://github.com/dimforge/rapier) |
