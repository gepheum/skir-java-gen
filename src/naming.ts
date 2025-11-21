import { Field, RecordLocation, convertCase } from "soiac";

export class Namer {
  private readonly genPackageFirstName: string;

  constructor(private readonly packagePrefix: string) {
    if (packagePrefix.length <= 0) {
      this.genPackageFirstName = "soiagen";
    } else {
      this.genPackageFirstName = packagePrefix.split(".")[0]!;
    }
  }

  structFieldToJavaName(field: Field | string): string {
    const soiaName = typeof field === "string" ? field : field.name.text;
    const lowerCamel = convertCase(soiaName, "lower_underscore", "lowerCamel");
    const nameConflict =
      JAVA_HARD_KEYWORDS.has(lowerCamel) ||
      TOP_LEVEL_PACKAGE_NAMES.has(lowerCamel) ||
      JAVA_OBJECT_SYMBOLS.has(lowerCamel) ||
      GENERATED_STRUCT_SYMBOLS.has(lowerCamel) ||
      lowerCamel === this.genPackageFirstName;
    return nameConflict ? lowerCamel + "_" : lowerCamel;
  }

  /** Returns the name of the frozen Kotlin class for the given record. */
  getClassName(record: RecordLocation): ClassName {
    const { recordAncestors } = record;
    const parts: string[] = [];
    const seenNames = new Set<string>();
    for (let i = 0; i < recordAncestors.length; ++i) {
      const record = recordAncestors[i]!;
      let name = record.name.text;
      if (
        name === "Kind" ||
        name === "Builder" ||
        /[^a-z]Wrapper$/.test(name) ||
        (i === 0 && (name === "Constants" || name === "Methods"))
      ) {
        name += "_";
      }
      while (seenNames.has(name)) {
        name += "_";
      }
      seenNames.add(name);
      parts.push(name);
    }

    const name = parts.at(-1)!;

    const path = record.modulePath;
    const importPath = path.replace(/\.soia$/, "").replace("/", ".");
    const qualifiedName = `${this.packagePrefix}soiagen.${importPath}.${parts.join(".")}`;

    return { name, qualifiedName };
  }
}

// TODO: update
const JAVA_HARD_KEYWORDS: ReadonlySet<string> = new Set([
  "abstract",
  "annotation",
  "as",
  "break",
  "catch",
  "class",
  "const",
  "continue",
  "crossinline",
  "data",
  "else",
  "enum",
  "external",
  "final",
  "finally",
  "for",
  "fun",
  "if",
  "import",
  "in",
  "inline",
  "interface",
  "internal",
  "is",
  "lateinit",
  "noinline",
  "object",
  "open",
  "operator",
  "override",
  "package",
  "private",
  "protected",
  "public",
  "reified",
  "return",
  "sealed",
  "super",
  "suspend",
  "this",
  "throw",
  "try",
  "typealias",
  "val",
  "var",
  "when",
  "while",
]);

const TOP_LEVEL_PACKAGE_NAMES: ReadonlySet<string> = new Set<string>([
  "java",
  "kotlin",
  "okio",
]);

// TODO: update
const JAVA_OBJECT_SYMBOLS: ReadonlySet<string> = new Set([
  "equals",
  "hashCode",
  "toString",
]);

// TODO: update
const GENERATED_STRUCT_SYMBOLS: ReadonlySet<string> = new Set([
  "builder",
  "partialBuilder",
  "toBuilder",
]);

export function toEnumConstantName(field: Field): string {
  const soiaName = field.name.text;
  return soiaName === "SERIALIZER" || soiaName === "TYPE_DESCRIPTOR"
    ? `${soiaName}_`
    : soiaName;
}

export interface ClassName {
  /** The name right after the 'class' keyword.. */
  name: string;
  /**
   * Fully qualified class name.
   * Examples: 'soiagen.Foo', 'soiagen.Foo.Bar'
   */
  qualifiedName: string;
}
