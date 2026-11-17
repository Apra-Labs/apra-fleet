# memory-contract/v1 -- NJsonSchema C# codegen smoke check

Status: evidence for T1.2.2's acceptance criterion that the emitted 2020-12
schemas do not "hit a wall" for the .NET consumers named in the format
decision. This is a note, not a test: the generated C# is throwaway and is
**not** committed anywhere in this repo (see the disposition below).

## What was probed

Three schemas from the 46 committed under `memory-contract/v1/schemas/`,
chosen per the bead's instruction (one `kb_*`, one `code_*`, one with a
discriminated union):

1. `kb_capture.request.json` -- a `kb_*` request schema; the largest/most
   varied shape in the surface (closed enums, an open string field, optional
   arrays).
2. `code_map.request.json` -- a `code_*` request schema; also the schema
   GENERATOR-DECISION.md names as the one real field
   (`z.number().int().positive()`) that forces the fallback generation path.
3. `kb_query.response.json` -- the surface's one genuine discriminated-union
   shape: its `parsed` property is an `anyOf` of two mutually exclusive
   object shapes (`{l1_results, l2_expanded, related_claims?}` vs
   `{flagged_entries, total, note}`), per INVENTORY.md finding F-8 / x-invariant
   INV-08.

## Tooling and command

- .NET SDK: `10.0.204` (`dotnet --version`)
- NJsonSchema: `11.6.1` (`NJsonSchema` + `NJsonSchema.CodeGeneration.CSharp`
  NuGet packages, installed via `dotnet add package`)
- Probe project: a throwaway `dotnet new console` app outside this repo,
  referencing the three files above by absolute path.
- Command run, per schema file:

  ```csharp
  var schema = await JsonSchema.FromFileAsync(path);
  var settings = new CSharpGeneratorSettings { ClassStyle = CSharpClassStyle.Poco };
  var generator = new CSharpGenerator(schema, settings);
  var code = generator.GenerateFile();
  ```

## Result

All three schemas load and generate C# without throwing:

| Schema | Result | Lines generated |
|---|---|---|
| `kb_capture.request.json` | OK | 172 |
| `code_map.request.json` | OK | 29 |
| `kb_query.response.json` | OK | 55 |

No exception, no crash, no metaschema complaint from NJsonSchema's own parser
for any of the three. The `$id` + `$ref`-to-`$defs` shape (from this task's
generator wiring, GENERATOR-DECISION.md section 5) round-trips through
`JsonSchema.FromFileAsync` cleanly -- `schema.HasReference` is true for all
three, as expected for a root `$ref`.

## Warning worth handing to the .NET consumers

**NJsonSchema drops branch-specific properties on an `anyOf`.** For
`kb_query.response.json`, the generated `Parsed` class -- the type for the
`parsed` property carrying the `anyOf` -- comes out as an **empty POCO** with
only a `JsonExtensionData`-backed `AdditionalProperties` dictionary:

```csharp
public partial class Parsed
{
    private System.Collections.Generic.IDictionary<string, object> _additionalProperties;

    [Newtonsoft.Json.JsonExtensionData]
    public System.Collections.Generic.IDictionary<string, object> AdditionalProperties
    {
        get { return _additionalProperties ?? (_additionalProperties = new System.Collections.Generic.Dictionary<string, object>()); }
        set { _additionalProperties = value; }
    }
}
```

Neither branch's fields (`l1_results`/`l2_expanded`/`related_claims`, nor
`flagged_entries`/`total`/`note`) are surfaced as typed members -- both are
collapsed into the untyped dictionary. A .NET consumer calling `kb_query` gets
no compile-time access to either response shape via this generator's default
(`CSharpClassStyle.Poco`) settings; they must read `AdditionalProperties` and
branch on which keys are present at runtime, mirroring what the JSON Schema
side already lost when the discriminated union degraded to `anyOf` (D1 /
INV-09 in GENERATOR-DECISION.md -- the `discriminator` hint that would let a
generator disambiguate branches is not present in 2020-12 `anyOf`, only in an
OpenAPI 3.1 `oneOf` + `discriminator` binding). This is the same degradation
GENERATOR-DECISION.md already recorded as D1, now confirmed to reach all the
way to generated C#, not just to the JSON Schema shape. Downstream consumers
of `kb_query`'s response (and any future tool whose "Body known" response is
itself a `z.union`) should not expect NJsonSchema-generated typed branches for
an `anyOf`; they need either a hand-written partial/converter or the OpenAPI
3.1 `discriminator` binding referenced in D1.

No other warning was observed for the two non-union schemas: `kb_capture`'s
open-string `role` field (INV-07) generates as a plain `string` property, as
expected -- NJsonSchema does not need to know it is deliberately unconstrained.

## Disposition

The generated C# itself (the three throwaway `.cs` outputs) is **not**
committed to this repository, per this task's acceptance criteria. This
markdown note is the only committed artifact from this smoke check.
