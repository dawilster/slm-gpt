import SwiftUI

/// Lightweight markdown renderer for assistant replies.
///
/// Handles **block-level** structure (paragraphs, headings, code blocks,
/// bullet/numbered lists, blockquotes) ourselves, and delegates **inline**
/// formatting (bold/italic/`code`/links) to `AttributedString(markdown:)`.
///
/// Streaming-safe: parses gracefully when the trailing markdown is
/// half-finished — an unclosed code fence keeps eating tokens until the
/// closing fence arrives, which is exactly what you want visually.
struct MarkdownText: View {
    let text: String
    /// Append a blinking caret to the last block while the model is still
    /// generating, so the user sees the live writing position.
    var isStreaming: Bool = false

    var body: some View {
        let blocks = MarkdownParser.parse(text)
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { idx, block in
                MarkdownBlockView(
                    block: block,
                    showCaret: isStreaming && idx == blocks.count - 1
                )
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - Block model

enum MarkdownBlock: Equatable {
    case heading(level: Int, content: String)
    case paragraph(String)
    case codeBlock(language: String?, body: String)
    case bulletList([String])
    case orderedList([String])
    case quote(String)
}

// MARK: - Per-block rendering

private struct MarkdownBlockView: View {
    let block: MarkdownBlock
    let showCaret: Bool

    var body: some View {
        switch block {
        case .heading(let level, let content):
            HStack(alignment: .firstTextBaseline, spacing: 0) {
                inlineText(content, font: headingFont(level), color: Color.haloFg)
                if showCaret { caret }
            }

        case .paragraph(let s):
            HStack(alignment: .firstTextBaseline, spacing: 0) {
                inlineText(s, font: .haloUI(15), color: Color.haloFg)
                    .lineSpacing(3)
                if showCaret { caret }
            }

        case .codeBlock(let lang, let body):
            CodeBlockView(language: lang, code: body, showCaret: showCaret)

        case .bulletList(let items):
            VStack(alignment: .leading, spacing: 4) {
                ForEach(Array(items.enumerated()), id: \.offset) { i, item in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text("•").foregroundStyle(Color.haloFgFaint)
                            .frame(width: 10, alignment: .trailing)
                        inlineText(item, font: .haloUI(15), color: Color.haloFg)
                        if showCaret && i == items.count - 1 { caret }
                    }
                }
            }

        case .orderedList(let items):
            VStack(alignment: .leading, spacing: 4) {
                ForEach(Array(items.enumerated()), id: \.offset) { i, item in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text("\(i + 1).")
                            .foregroundStyle(Color.haloFgFaint)
                            .font(.haloMono(13))
                            .frame(width: 18, alignment: .trailing)
                        inlineText(item, font: .haloUI(15), color: Color.haloFg)
                        if showCaret && i == items.count - 1 { caret }
                    }
                }
            }

        case .quote(let s):
            HStack(alignment: .top, spacing: 10) {
                Rectangle()
                    .fill(Color.haloAccent.opacity(0.55))
                    .frame(width: 2)
                inlineText(s, font: .haloUI(14), color: Color.haloFgDim)
                    .italic()
                if showCaret { caret }
            }
        }
    }

    private var caret: some View {
        // Subtle blinking caret at the live writing position.
        Rectangle()
            .fill(Color.haloAccent)
            .frame(width: 6, height: 16)
            .padding(.leading, 2)
            .opacity(0.85)
    }

    private func headingFont(_ level: Int) -> Font {
        switch level {
        case 1: return .haloUI(20, weight: .semibold)
        case 2: return .haloUI(17, weight: .semibold)
        case 3: return .haloUI(15, weight: .semibold)
        default: return .haloUI(14, weight: .medium)
        }
    }

    /// Renders inline markdown (bold/italic/inline code/links) via SwiftUI's
    /// built-in AttributedString markdown init. Falls back to plain text if
    /// the input is malformed (common during streaming).
    private func inlineText(_ s: String, font: Font, color: Color) -> Text {
        let attributed: AttributedString = {
            do {
                var opts = AttributedString.MarkdownParsingOptions()
                opts.interpretedSyntax = .inlineOnlyPreservingWhitespace
                return try AttributedString(markdown: s, options: opts)
            } catch {
                return AttributedString(s)
            }
        }()
        return Text(attributed)
            .font(font)
            .foregroundColor(color)
    }
}

// MARK: - Code block

private struct CodeBlockView: View {
    let language: String?
    let code: String
    let showCaret: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let lang = language, !lang.isEmpty {
                Text(lang.uppercased())
                    .font(.haloMono(9.5, weight: .semibold))
                    .tracking(0.6)
                    .foregroundStyle(Color.haloFgFaint)
                    .padding(.horizontal, 12)
                    .padding(.top, 8)
                    .padding(.bottom, 4)
            }

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(alignment: .firstTextBaseline, spacing: 0) {
                    Text(code)
                        .font(.haloMono(12.5))
                        .foregroundStyle(Color.haloFg)
                        .textSelection(.enabled)
                    if showCaret {
                        Rectangle()
                            .fill(Color.haloAccent)
                            .frame(width: 6, height: 14)
                            .padding(.leading, 2)
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, language?.isEmpty == false ? 4 : 10)
                .padding(.bottom, 10)
            }
        }
        .background(Color.black.opacity(0.30))
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .stroke(Color.white.opacity(0.06), lineWidth: 0.5)
        )
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
    }
}

// MARK: - Block parser

enum MarkdownParser {
    static func parse(_ text: String) -> [MarkdownBlock] {
        var blocks: [MarkdownBlock] = []
        let rawLines = text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        var i = 0

        while i < rawLines.count {
            let line = rawLines[i]

            // Fenced code block (``` or ~~~)
            if let fence = matchFence(line) {
                let lang = String(line.dropFirst(fence.count)).trimmingCharacters(in: .whitespaces)
                i += 1
                var body: [String] = []
                while i < rawLines.count, matchFence(rawLines[i]) == nil {
                    body.append(rawLines[i])
                    i += 1
                }
                if i < rawLines.count { i += 1 } // consume closing fence (if present)
                blocks.append(.codeBlock(language: lang.isEmpty ? nil : lang,
                                        body: body.joined(separator: "\n")))
                continue
            }

            // ATX heading
            if let lvl = headingLevel(line) {
                let stripped = String(line.drop(while: { $0 == "#" }))
                    .trimmingCharacters(in: .whitespaces)
                blocks.append(.heading(level: lvl, content: stripped))
                i += 1
                continue
            }

            // Blockquote (one or more consecutive `> ` lines)
            if line.hasPrefix("> ") || line.hasPrefix(">") {
                var quoted: [String] = []
                while i < rawLines.count,
                      rawLines[i].hasPrefix(">") {
                    let dropped = rawLines[i].dropFirst(rawLines[i].hasPrefix("> ") ? 2 : 1)
                    quoted.append(String(dropped))
                    i += 1
                }
                blocks.append(.quote(quoted.joined(separator: "\n")))
                continue
            }

            // Bullet list
            if isBullet(line) {
                var items: [String] = []
                while i < rawLines.count, isBullet(rawLines[i]) {
                    items.append(stripBullet(rawLines[i]))
                    i += 1
                }
                blocks.append(.bulletList(items))
                continue
            }

            // Ordered list
            if isNumbered(line) {
                var items: [String] = []
                while i < rawLines.count, isNumbered(rawLines[i]) {
                    items.append(stripNumbered(rawLines[i]))
                    i += 1
                }
                blocks.append(.orderedList(items))
                continue
            }

            // Blank line — skip
            if line.trimmingCharacters(in: .whitespaces).isEmpty {
                i += 1
                continue
            }

            // Paragraph: consume until blank line or block-starting marker.
            var para: [String] = []
            while i < rawLines.count {
                let l = rawLines[i]
                if l.trimmingCharacters(in: .whitespaces).isEmpty { break }
                if matchFence(l) != nil { break }
                if headingLevel(l) != nil { break }
                if isBullet(l) || isNumbered(l) { break }
                if l.hasPrefix(">") { break }
                para.append(l)
                i += 1
            }
            if !para.isEmpty {
                blocks.append(.paragraph(para.joined(separator: "\n")))
            }
        }
        return blocks
    }

    private static func matchFence(_ line: String) -> String? {
        if line.hasPrefix("```") { return "```" }
        if line.hasPrefix("~~~") { return "~~~" }
        return nil
    }

    private static func headingLevel(_ line: String) -> Int? {
        var hashes = 0
        for c in line {
            if c == "#" { hashes += 1 } else { break }
        }
        guard hashes >= 1, hashes <= 6 else { return nil }
        // Must be followed by a space (or end-of-line) to be a heading.
        let idx = line.index(line.startIndex, offsetBy: hashes)
        if idx == line.endIndex { return hashes }
        return line[idx] == " " ? hashes : nil
    }

    private static func isBullet(_ line: String) -> Bool {
        let t = line.drop(while: { $0 == " " })
        return t.hasPrefix("- ") || t.hasPrefix("* ") || t.hasPrefix("+ ")
    }
    private static func stripBullet(_ line: String) -> String {
        let t = String(line.drop(while: { $0 == " " }))
        return String(t.dropFirst(2))
    }

    private static let numberedRegex = /^\s*\d+\.\s+/
    private static func isNumbered(_ line: String) -> Bool {
        line.firstMatch(of: Self.numberedRegex) != nil
    }
    private static func stripNumbered(_ line: String) -> String {
        guard let m = line.firstMatch(of: Self.numberedRegex) else { return line }
        return String(line[m.range.upperBound...])
    }
}
