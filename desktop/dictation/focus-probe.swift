// desktop/dictation/focus-probe.swift
//
// Probe the system-wide focused UI element via AXUIElement and report whether
// it accepts text input. Used by dictation-service to decide between
// clipboard-only (no focused field) and clipboard+paste (focused text field).
//
// Output: a single line of JSON on stdout, e.g.
//   {"isTextInput":true,"role":"AXTextField","subrole":""}
// Exit code is always 0 — failure is conveyed as isTextInput:false so the
// caller never has to disambiguate "no focus" from "probe crashed".
//
// Requires macOS Accessibility permission (shared with uiohook-napi). Without
// it AXUIElementCopyAttributeValue returns kAXErrorAPIDisabled and we report
// isTextInput:false, which preserves clipboard-only behavior.

import ApplicationServices
import Foundation

struct ProbeResult {
    let isTextInput: Bool
    let role: String
    let subrole: String
}

func copyString(_ element: AXUIElement, _ attribute: String) -> String {
    var ref: CFTypeRef?
    let err = AXUIElementCopyAttributeValue(element, attribute as CFString, &ref)
    guard err == .success else { return "" }
    return (ref as? String) ?? ""
}

func isSettable(_ element: AXUIElement, _ attribute: String) -> Bool {
    var settable: DarwinBoolean = false
    let err = AXUIElementIsAttributeSettable(element, attribute as CFString, &settable)
    return err == .success && settable.boolValue
}

func probe() -> ProbeResult {
    let system = AXUIElementCreateSystemWide()
    var focusedRef: CFTypeRef?
    let err = AXUIElementCopyAttributeValue(
        system, kAXFocusedUIElementAttribute as CFString, &focusedRef
    )
    guard err == .success, let focusedRef = focusedRef else {
        return ProbeResult(isTextInput: false, role: "", subrole: "")
    }

    let element = focusedRef as! AXUIElement
    let role = copyString(element, kAXRoleAttribute as String)
    let subrole = copyString(element, kAXSubroleAttribute as String)

    // Strong, unambiguous text-input roles. Covers native AppKit text fields,
    // multi-line text views, search bars, and combo boxes' text portion.
    let textRoles: Set<String> = [
        "AXTextField",
        "AXTextArea",
        "AXComboBox",
        "AXSearchField"
    ]
    if textRoles.contains(role) {
        return ProbeResult(isTextInput: true, role: role, subrole: subrole)
    }

    // Fallback for web / Electron renderers: contenteditable elements often
    // surface as generic AXGroup / AXScrollArea but still mark AXValue as
    // settable. Querying settability is the canonical AX way to ask
    // "can I type into this?" without exhaustively enumerating Chromium's
    // role mapping.
    if isSettable(element, kAXValueAttribute as String) {
        return ProbeResult(isTextInput: true, role: role, subrole: subrole)
    }

    return ProbeResult(isTextInput: false, role: role, subrole: subrole)
}

func escape(_ value: String) -> String {
    // Minimal JSON string escaping — role/subrole are AX constants like
    // "AXTextField"; backslashes and quotes never occur in practice but we
    // handle them anyway so a malformed third-party app can't break the JSON.
    var out = ""
    out.reserveCapacity(value.count)
    for ch in value {
        switch ch {
        case "\"": out += "\\\""
        case "\\": out += "\\\\"
        case "\n": out += "\\n"
        case "\r": out += "\\r"
        case "\t": out += "\\t"
        default:
            if ch.asciiValue.map({ $0 < 0x20 }) ?? false {
                out += String(format: "\\u%04x", Int(ch.asciiValue ?? 0))
            } else {
                out.append(ch)
            }
        }
    }
    return out
}

let result = probe()
let json = "{\"isTextInput\":\(result.isTextInput ? "true" : "false")," +
    "\"role\":\"\(escape(result.role))\"," +
    "\"subrole\":\"\(escape(result.subrole))\"}"
print(json)
exit(0)
