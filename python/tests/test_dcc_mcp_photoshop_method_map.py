import json
import pathlib
import sys
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[2]
PYTHON_ROOT = ROOT / "python"
if str(PYTHON_ROOT) not in sys.path:
    sys.path.insert(0, str(PYTHON_ROOT))

from adobe.photoshop import Photoshop

METHOD_MAP = ROOT / "contracts" / "dcc_mcp_photoshop_methods.json"

LEGACY_METHODS = {
    "ps.getDocumentInfo",
    "ps.listDocuments",
    "ps.createDocument",
    "ps.saveDocument",
    "ps.closeDocument",
    "ps.exportDocument",
    "ps.resizeCanvas",
    "ps.resizeImage",
    "ps.flattenImage",
    "ps.mergeVisibleLayers",
    "ps.listLayers",
    "ps.createLayer",
    "ps.deleteLayer",
    "ps.setLayerVisibility",
    "ps.renameLayer",
    "ps.setLayerOpacity",
    "ps.duplicateLayer",
    "ps.setLayerBlendMode",
    "ps.fillLayer",
    "ps.createTextLayer",
    "ps.updateTextLayer",
    "ps.getTextLayerInfo",
    "ps.executeScript",
    "ps.executeAction",
    "ps.describeApi",
    "ps.invoke",
    "ps.batchPlay",
}


class CapturingClient:
    target = "default"

    def __init__(self):
        self.calls = []

    def call(self, host, namespace, method, args=None, options=None, target=None):
        self.calls.append(
            {
                "host": host,
                "namespace": namespace,
                "method": method,
                "args": list(args or []),
                "options": options or {},
                "target": target,
            }
        )
        if namespace == "app" and method == "getDocuments":
            return [{"id": 7, "name": "hero.psd"}]
        if namespace == "document" and method == "getActive":
            return {"id": 7, "name": "hero.psd", "width": 1920, "height": 1080}
        if namespace == "document" and method == "getActiveLayers":
            return [{"id": 11, "name": "Hero", "kind": "pixel", "visible": True}]
        if namespace == "document" and method == "export":
            return {"id": args[0]["id"], "path": args[0]["path"], "format": args[0]["format"]}
        if namespace == "export" and method == "exportWithPreset":
            return {"id": args[0]["id"], "path": args[0]["path"], "preset": args[0]["preset"]}
        if namespace == "layer" and method == "getActive":
            return {"id": 11, "documentId": 7, "name": "Hero", "kind": "text", "visible": True}
        if namespace == "text" and method in {"getByLayerId", "getActive"}:
            return {"layerId": 11, "contents": "Old", "characterStyle": {}, "paragraphStyle": {}}
        if namespace == "text" and method in {"setContents", "setCharacterStyle", "setParagraphStyle"}:
            return {"layerId": args[0], "contents": args[1] if method == "setContents" else "Old", "characterStyle": {}, "paragraphStyle": {}}
        if namespace == "filter":
            return {"id": args[0], "name": "Hero", "lastFilter": method}
        if namespace == "smartObject":
            return {"id": args[0]["layerId"], "documentId": args[0]["documentId"], "name": "Hero", "isSmartObject": True}
        if namespace == "raw":
            return {"path": list(args[0]) if args else [], "args": list(args[1]) if len(args or []) > 1 and isinstance(args[1], list) else []}
        if namespace == "action":
            return [{"ok": True}]
        return {"ok": True}

    def capabilities(self):
        return [
            {
                "target": "default",
                "connectedAtEpochMs": 1,
                "capabilities": {
                    "host": "photoshop",
                    "bridgeKind": "uxp",
                    "bridgeVersion": "0.1.0",
                    "hostVersion": "26.0",
                    "namespaces": ["app", "document", "layer", "text", "filter", "smartObject", "export", "raw", "action"],
                    "features": ["batchPlay", "modal"],
                    "methods": {
                        "app": ["getDocuments"],
                        "document": ["getActive", "getActiveLayers", "export"],
                        "layer": ["getActive"],
                        "text": ["getActive", "getByLayerId", "setContents", "setCharacterStyle", "setParagraphStyle"],
                        "filter": ["applyGaussianBlur"],
                        "smartObject": ["convertToSmartObject"],
                        "export": ["exportWithPreset"],
                        "raw": ["evalJs", "getPath", "callPath"],
                        "action": ["batchPlay"],
                    },
                },
            }
        ]


class DccMcpPhotoshopMethodMapTests(unittest.TestCase):
    def test_legacy_method_map_covers_current_dcc_mcp_photoshop_surface(self):
        payload = json.loads(METHOD_MAP.read_text(encoding="utf-8"))
        entries = payload["methods"]
        mapped = {entry["legacyMethod"] for entry in entries}

        self.assertEqual(mapped, LEGACY_METHODS)
        self.assertEqual(len(entries), len(mapped))
        for entry in entries:
            self.assertIn(entry["route"], {"typed_facade", "dom_escape_hatch", "batch_play", "raw_eval", "capability_contract"})
            self.assertIn(entry["modalPolicy"], {"not_required", "modal_required", "caller_option"})
            self.assertTrue(entry["adobepy"])

    def test_mutating_legacy_methods_have_explicit_modal_policy(self):
        entries = json.loads(METHOD_MAP.read_text(encoding="utf-8"))["methods"]
        mutating = [entry for entry in entries if entry["legacyMethod"] not in {"ps.getDocumentInfo", "ps.listDocuments", "ps.listLayers", "ps.getTextLayerInfo", "ps.describeApi"}]

        self.assertTrue(mutating)
        for entry in mutating:
            self.assertNotEqual(entry["modalPolicy"], "not_required", entry["legacyMethod"])

    def test_representative_legacy_method_families_are_expressible_with_adobepy(self):
        client = CapturingClient()
        app = Photoshop(client=client)

        self.assertEqual(app.active_document.name, "hero.psd")
        self.assertEqual(app.documents[0].name, "hero.psd")
        self.assertEqual([layer.name for layer in app.active_layers], ["Hero"])
        app.active_document.export("C:/out.png", modal=True)
        app.active_document.export_with_preset("png", "C:/out.png", modal=True)
        app.dom.app.documents.add({"name": "Untitled"}, modal=True)
        app.dom.app.activeDocument.resizeImage({"width": 800}, modal=True)
        app.dom.app.activeDocument.flatten(modal=True)
        app.eval_js("app.documents.length")
        with app.execute_as_modal(command_name="Legacy batchPlay"):
            app.batch_play([{"_obj": "hide"}])
        layer = app.active_layer
        layer.filters.apply_gaussian_blur(2)
        layer.smart_object.convert_to_smart_object()
        layer.text_item.set_contents("New", command_name="Text")

        namespaces = {(call["namespace"], call["method"]) for call in client.calls}
        self.assertIn(("document", "getActive"), namespaces)
        self.assertIn(("document", "getActiveLayers"), namespaces)
        self.assertIn(("document", "export"), namespaces)
        self.assertIn(("export", "exportWithPreset"), namespaces)
        self.assertIn(("raw", "callPath"), namespaces)
        self.assertIn(("raw", "evalJs"), namespaces)
        self.assertIn(("action", "batchPlay"), namespaces)
        self.assertIn(("filter", "applyGaussianBlur"), namespaces)
        self.assertIn(("smartObject", "convertToSmartObject"), namespaces)
        self.assertIn(("text", "setContents"), namespaces)
        modal_calls = [call for call in client.calls if call["namespace"] in {"raw", "action", "document", "export", "text", "filter", "smartObject"} and call["method"] not in {"evalJs", "getPath", "getByLayerId"}]
        self.assertTrue(modal_calls)
        self.assertTrue(any(call["options"].get("modal") for call in modal_calls))


if __name__ == "__main__":
    unittest.main()
