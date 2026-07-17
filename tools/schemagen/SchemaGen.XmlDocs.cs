using System.Text;
using System.Text.RegularExpressions;
using System.Xml.Linq;

internal sealed partial class SchemaGen
{
    // ---- XML documentation (prose field descriptions) ----
    // The game ships compiler-generated XML doc files next to each assembly (Cosmoteer.xml,
    // HalflingCore.xml). Index every member's <summary> by its XML doc-ID (`F:Type.Field` for a field,
    // `P:Type.Prop` for a property) so OwnFields can attach the prose to the matching serialized field.
    // The descriptions are emitted to a separate `field-docs.seed.json`, never into the schema itself.
    // The docs scaffolder turns that seed into editable Markdown (see docs/fields and field-docs.ts). The
    // separation keeps a schemagen regen from clobbering hand-written community docs.
    void LoadXmlDocs()
    {
        foreach (var path in schemaDlls)
        {
            var xmlPath = Path.ChangeExtension(path, ".xml");
            if (!File.Exists(xmlPath)) continue;
            XDocument xd;
            try { xd = XDocument.Load(xmlPath); }
            catch (Exception e) { Console.Error.WriteLine($"warning: could not read {Path.GetFileName(xmlPath)}: {e.Message}"); continue; }
            foreach (var mem in xd.Descendants("member"))
            {
                var id = mem.Attribute("name")?.Value;
                var summary = mem.Element("summary");
                if (string.IsNullOrEmpty(id) || summary == null) continue;
                var text = Summarize(summary);
                if (!string.IsNullOrEmpty(text)) xmlDocs.TryAdd(id!, text);
            }
        }
    }

    // The readable text of a `<summary>`: concatenate its text, resolving `<see cref>`/`<paramref>` to the
    // referenced short name and flattening inline tags, then collapse XML-doc indentation to single spaces.
    static string Summarize(XElement el)
    {
        var sb = new StringBuilder();
        void Walk(XElement e)
        {
            foreach (var node in e.Nodes())
            {
                if (node is XText txt) { sb.Append(txt.Value); continue; }
                if (node is not XElement ce) continue;
                switch (ce.Name.LocalName)
                {
                    case "see":
                    case "seealso":
                        var cref = ce.Attribute("cref")?.Value ?? ce.Attribute("langword")?.Value ?? "";
                        var colon = cref.IndexOf(':'); if (colon >= 0) cref = cref[(colon + 1)..];
                        var tick = cref.IndexOf('`'); if (tick >= 0) cref = cref[..tick];
                        var dot = cref.LastIndexOf('.');
                        sb.Append(dot >= 0 ? cref[(dot + 1)..] : cref);
                        break;
                    case "paramref":
                    case "typeparamref":
                        sb.Append(ce.Attribute("name")?.Value ?? "");
                        break;
                    default:
                        Walk(ce);   // c / para / list / etc. (keep their inner text)
                        break;
                }
            }
        }
        Walk(el);
        var text = Regex.Replace(sb.ToString(), @"\s+", " ").Trim();
        // The XML docs are written for engine developers. Two mechanical rewrites make them read as modder
        // field docs: drop the C# copy-plumbing boilerplate (meaningless in a .rules file), and turn the
        // C# property phrasing (`Gets or sets whether …`) into a direct description (`Whether …`).
        text = Regex.Replace(text, @"\s*This (?:property|member) [^.]*?CopySettingsFrom\(\)[^.]*\.?", "");
        text = Regex.Replace(text, @"^Gets(?: or sets)? a value indicating whether ", "Whether ");
        text = Regex.Replace(text, @"^Gets(?: or sets)? ", "");
        text = text.Trim();
        if (text.Length > 0) text = char.ToUpperInvariant(text[0]) + text[1..];
        return text;
    }
}
