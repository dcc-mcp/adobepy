# adobepy Usage

## Broker

```powershell
adobepy broker --token dev-token
```

The broker listens on `127.0.0.1:47391` and exposes `/health`,
`/v1/capabilities`, `/v1/rpc`, and bridge/client WebSocket routes. Authenticated
routes use `x-adobepy-token`.

## Python

```powershell
$env:ADOBEPY_TOKEN = "dev-token"
python -c "from adobe.photoshop import Photoshop; print(Photoshop(token='dev-token').version)"
```

Photoshop exposes JS-shaped aliases such as `activeDocument`,
`executeAsModal()`, and `action.batchPlay()`, plus Pythonic aliases such as
`active_document` and `batch_play()`.

The MVP facade modules are `adobe.photoshop`, `adobe.indesign`,
`adobe.premiere`, `adobe.after_effects`, and `adobe.illustrator`. Legacy CEP
hosts expose typed convenience properties for version/current project or
document, plus raw ExtendScript through `adobe.raw`.

InDesign mirrors common DOM names while keeping Pythonic aliases:

```python
from adobe.indesign import InDesign

app = InDesign()
doc = app.active_document

for swatch in doc.swatches:
    print(swatch.name, swatch.color_value)

doc.add_color_swatch("Brand Blue", [10, 20, 200], space="RGB")

for link in doc.links:
    if link.status != "normal":
        link.update()

doc.getLink("hero.png").relink("C:/assets/hero-new.png")
doc.exports.pdf("C:/out/layout.pdf")
doc.package.for_print("C:/out/package")
```

After Effects exposes typed project item metadata for compositions, footage, and
folders while keeping raw ExtendScript available for host-specific operations
that are not modeled yet:

```python
from adobe.after_effects import AfterEffects

app = AfterEffects()

for comp in app.project.compositions:
    print(comp.name, comp.width, comp.height, comp.duration, comp.frame_rate)

for footage in app.project.footage_items:
    print(footage.name, footage.file_path, footage.missing_footage)

active = app.active_item
selected = app.selected_items

comp = app.project.compositions[0]
for layer in comp.layers:
    print(layer.index, layer.name, layer.enabled)
    for effect in layer.effects:
        print(effect.name, effect.match_name)
    for mask in layer.masks:
        print(mask.name, mask.mask_mode)

text = comp.get_layer_by_id(11).source_text
comp.selected_layers[0].set_source_text("Updated title")

render_queue = app.project.render_queue
queued = render_queue.queue_selected_compositions(
    output_directory="C:/renders/review",
    command_name="Queue selected comps",
)

item = queued[0] if queued else comp.add_to_render_queue(output_path="C:/renders/main.mov")
module = item.output_module(1)
module.apply_template("Lossless")
module.set_output_path("C:/renders/main.mov")
```

Use `adobe.raw.RawSession("after-effects").eval_extendscript(...)` for APIs
outside the typed composition/project-item/render-queue facade, such as deep
layer/property mutation before those namespaces are added.

Illustrator exposes common document, artboard, layer, and page-item collections
with JavaScript-shaped names and Pythonic aliases:

```python
from adobe.illustrator import Illustrator

app = Illustrator()
doc = app.active_document

print(doc.name, doc.active_artboard.name, doc.active_artboard_index)

for artboard in doc.artboards:
    print(artboard.index, artboard.name, artboard.artboard_rect)

for layer in doc.layers:
    print(layer.name, layer.visible, layer.locked)
    for child in layer.layers:
        print("child", child.name)
    for item in layer.page_items:
        print(item.typename, item.name, item.geometric_bounds)

for item in doc.selection:
    print(item.name, item.layer_name)

logo = doc.get_page_item_by_name("Logo")

for path in doc.path_items:
    print(path.name, path.closed, path.fill_color, path.stroke_width)

for compound in doc.compound_path_items:
    print(compound.name, compound.path_item_count)
    for child_path in compound.path_items:
        print(child_path.name, child_path.path_point_count)

for placed in doc.placed_items:
    print(placed.name, placed.file_path)

for raster in doc.selected_raster_items:
    print(raster.name, raster.file_path, raster.image_color_space)
```

Use `adobe.raw.RawSession("illustrator").eval_extendscript(...)` for Illustrator
APIs outside the typed document/artboard/layer/page-item/path/placed/raster
facade. Geometry mutations such as `PathItem.setEntirePath`, `translate`,
`resize`, and `rotate` are intentionally deferred in the typed facade until
their mutation semantics and modal/error behavior are covered by replay or live
host tests. Text-frame editing, swatches, colors, and export workflows are also
still outside the typed Illustrator MVP surface.

## Bridges

```powershell
adobepy install-bridge photoshop --dest C:\Temp\adobepy-photoshop-bridge --token dev-token
```

UXP templates cover Photoshop, InDesign, and Premiere. CEP templates cover After
Effects and Illustrator. Host-specific loading, signing, and marketplace flows
remain Adobe workflows.

The UXP manifests allow the default local broker WebSocket endpoints on
`127.0.0.1:47391` and `localhost:47391`. If you run the broker on a different
port or host, update the bridge manifest's `requiredPermissions.network.domains`
before loading the plugin.
