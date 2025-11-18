// TODO: just use sorted fields everywhere

import {
  type CodeGenerator,
  type Constant,
  convertCase,
  type Method,
  Record,
  type RecordKey,
  type RecordLocation,
  ResolvedType,
} from "soiac";
import { z } from "zod";
import { Namer } from "./naming.js";
import { TypeSpeller } from "./type_speller.js";

const Config = z.object({
  packagePrefix: z
    .string()
    .regex(/^([a-z_$][a-z0-9_$]*\.)*$/)
    .optional(),
});

type Config = z.infer<typeof Config>;

class JavaCodeGenerator implements CodeGenerator<Config> {
  readonly id = "java";
  readonly configType = Config;
  readonly version = "1.0.0";

  generateCode(input: CodeGenerator.Input<Config>): CodeGenerator.Output {
    const { recordMap, config } = input;
    const outputFiles: CodeGenerator.OutputFile[] = [];
    for (const module of input.modules) {
      for (const declaration of module.declarations) {
        if (
          declaration.kind === "import" ||
          declaration.kind === "import-alias"
        ) {
          continue;
        }
        const sourceFile = new JavaSourceFileGenerator(
          declaration,
          module.path,
          recordMap,
          config,
        );
        outputFiles.push({
          path: sourceFile.path,
          code: sourceFile.generate(),
        });
      }
    }
    return { files: outputFiles };
  }
}

// Generates the code for one Java file.
class JavaSourceFileGenerator {
  constructor(
    private readonly declaration: Record | Method | Constant,
    private readonly modulePath: string,
    private readonly recordMap: ReadonlyMap<RecordKey, RecordLocation>,
    config: Config,
  ) {
    this.packagePrefix = config.packagePrefix ?? "";
    this.namer = new Namer(this.packagePrefix);
    this.typeSpeller = new TypeSpeller(recordMap, this.namer);
  }

  generate(): string {
    // http://patorjk.com/software/taag/#f=Doom&t=Do%20not%20edit
    this.push(
      `//  ______                        _               _  _  _
      //  |  _  \\                      | |             | |(_)| |
      //  | | | |  ___    _ __    ___  | |_    ___   __| | _ | |_
      //  | | | | / _ \\  | '_ \\  / _ \\ | __|  / _ \\ / _\` || || __|
      //  | |/ / | (_) | | | | || (_) || |_  |  __/| (_| || || |_ 
      //  |___/   \\___/  |_| |_| \\___/  \\__|  \\___| \\__,_||_| \\__|
      //

      // To install the Soia client library, add:
      //   implementation("land.soia:soia-kotlin-client:latest.release")
      // to your build.gradle.kts file

      `,
      `package ${this.packagePrefix}soiagen.`,
      this.modulePath.replace(/\.soia$/, "").replace("/", "."),
      ";\n\n",
    );

    const { declaration } = this;
    switch (declaration.kind) {
      case "record":
        this.writeClassForRecord(declaration, "top-level");
    }

    return this.joinLinesAndFixFormatting();
  }

  private writeClassForRecord(
    record: Record,
    nested: "nested" | "top-level",
  ): void {
    if (record.recordType === "struct") {
      this.writeClassForStruct(record, nested);
    } else {
      this.writeClassForEnum(record, nested);
    }
  }

  private writeClassForStruct(
    record: Record,
    nested: "nested" | "top-level",
  ): void {
    const { namer, recordMap, typeSpeller } = this;
    const recordLocation = recordMap.get(record.key)!;
    const className = this.namer.getClassName(recordLocation).name;
    const fields = [...record.fields];
    fields.sort((a, b) => a.name.text.localeCompare(b.name.text));
    this.push(
      "public ",
      nested === "nested" ? "static " : "",
      `final class ${className} {\n`,
    );

    // Declare fields
    for (const field of fields) {
      const fieldName = namer.structFieldToJavaName(field);
      const type = typeSpeller.getJavaType(field.type!, "frozen");
      this.push(`private final ${type} ${fieldName};\n`);
    }
    const unrecognizedFieldsType = `land.soia.internal.UnrecognizedFields<${className}>`;
    this.push(`private final ${unrecognizedFieldsType} _u;\n\n`);

    // Constructor
    this.push(`private ${className}(\n`);
    for (const field of fields) {
      const fieldName = namer.structFieldToJavaName(field);
      const type = typeSpeller.getJavaType(field.type!, "frozen");
      this.push(`${type} ${fieldName},\n`);
    }
    this.push(`${unrecognizedFieldsType} _u\n`, ") {\n");
    for (const field of fields) {
      const fieldName = namer.structFieldToJavaName(field);
      this.push(`this.${fieldName} = ${fieldName};\n`);
    }
    this.push("this._u = _u;\n", "}\n\n");

    // DEFAULT instance
    this.push(`private ${className}() {\n`);
    for (const field of fields) {
      const fieldName = namer.structFieldToJavaName(field);
      if (field.isRecursive === "hard") {
        this.push(`this.${fieldName} = null;\n`);
      } else {
        const defaultExpr = this.getDefaultExpression(field.type!);
        this.push(`this.${fieldName} = ${defaultExpr};\n`);
      }
    }
    this.push(
      "this._u = null;\n",
      "}\n\n",
      `public static final ${className} DEFAULT = new ${className}();\n\n`,
    );

    // Getters
    for (const field of fields) {
      const fieldName = namer.structFieldToJavaName(field);
      const type = typeSpeller.getJavaType(field.type!, "frozen");
      this.push(`public ${type} ${fieldName}() {\n`);
      if (field.isRecursive === "hard") {
        const defaultExpr = this.getDefaultExpression(field.type!);
        this.push(
          `if (this.${fieldName} != null) {\n`,
          `return this.${fieldName};\n`,
          `} else {\n`,
          `return ${defaultExpr};\n`,
          "}\n",
        );
      } else {
        this.push(`return this.${fieldName};\n`);
      }
      this.push("}\n\n");
    }

    // Methods
    this.push(`public Builder toBuilder() {\n`);
    this.push(`return new Builder(\n`);
    for (const field of fields) {
      const fieldName = namer.structFieldToJavaName(field);
      this.push(`this.${fieldName},\n`);
    }
    this.push("this._u);\n", "}\n\n");

    // builder()
    {
      const firstField = fields[0];
      const retType = firstField
        ? "Builder_At" +
          convertCase(firstField.name.text, "lower_underscore", "UpperCamel")
        : "Builder_Done";
      this.push(
        `public static ${retType} builder() {\n`,
        "return new Builder();\n",
        "}\n\n",
      );
    }

    // partialBuilder()
    this.push(
      "public static Builder partialBuilder() {\n",
      "return new Builder();\n",
      "}\n\n",
    );

    // Builder_At? interfaces
    for (const [index, field] of fields.entries()) {
      const fieldName = namer.structFieldToJavaName(field);
      const nextField = index < fields.length - 1 ? fields[index + 1] : null;
      const upperCamelName = convertCase(
        field.name.text,
        "lower_underscore",
        "UpperCamel",
      );
      const retType = nextField
        ? "Builder_At" +
          convertCase(nextField.name.text, "lower_underscore", "UpperCamel")
        : "Builder_Done";
      const paramType = typeSpeller.getJavaType(field.type!, "initializer");
      this.push(
        `public interface Builder_At${upperCamelName} {\n`,
        `${retType} set${upperCamelName}(${paramType} ${fieldName});\n`,
        "}\n\n",
      );
    }
    this.push(
      `public interface Builder_Done {\n`,
      `${className} build();\n`,
      "}\n\n",
    );

    // Builder class
    this.push("public static final class Builder implements ");
    for (const field of fields) {
      const upperCamelName = convertCase(
        field.name.text,
        "lower_underscore",
        "UpperCamel",
      );
      this.push(`Builder_At${upperCamelName}, `);
    }
    this.push("Builder_Done {\n");
    for (const field of fields) {
      const fieldName = namer.structFieldToJavaName(field);
      const type = typeSpeller.getJavaType(field.type!, "frozen");
      this.push(`private ${type} ${fieldName};\n`);
    }

    // Builder constructors
    this.push(
      `private final ${unrecognizedFieldsType} _u;\n\n`,
      "private Builder(\n",
    );
    for (const field of fields) {
      const fieldName = namer.structFieldToJavaName(field);
      const type = typeSpeller.getJavaType(field.type!, "frozen");
      this.push(`${type} ${fieldName},\n`);
    }
    this.push(`${unrecognizedFieldsType} _u\n`, ") {\n");
    for (const field of fields) {
      const fieldName = namer.structFieldToJavaName(field);
      this.push(`this.${fieldName} = ${fieldName};\n`);
    }
    this.push("this._u = _u;\n", "}\n\n");

    this.push("private Builder() {\n");
    for (const field of fields) {
      const fieldName = namer.structFieldToJavaName(field);
      const defaultExpr = this.getDefaultExpression(field.type!);
      this.push(`this.${fieldName} = ${defaultExpr};\n`);
    }
    this.push("this._u = null;\n", "}\n\n");

    // Setters
    for (const field of fields) {
      const fieldName = namer.structFieldToJavaName(field);
      const upperCamelName = convertCase(
        field.name.text,
        "lower_underscore",
        "UpperCamel",
      );
      const type = field.type!;
      const javaType = typeSpeller.getJavaType(type, "initializer");
      this.push(
        "@java.lang.Override\n",
        `public Builder set${upperCamelName}(${javaType} ${fieldName}) {\n`,
      );
      const toFrozenExpr = this.toFrozenExpression(
        fieldName,
        type,
        "can-be-null",
        "_e",
      );
      this.push(
        `this.${fieldName} = ${toFrozenExpr};\n`,
        "return this;\n",
        "}\n\n",
      );
      const isStruct =
        type.kind === "record" &&
        recordMap.get(type.key)!.record.recordType === "struct";
      if (isStruct) {
        const updaterType = `java.util.function.Function<? super ${javaType}, ? extends ${javaType}>`;
        this.push(
          `public Builder update${upperCamelName}(${updaterType} updater) {\n`,
          `return set${upperCamelName}(updater.apply(this.${fieldName}));\n`,
          "}\n\n",
        );
      }
    }
    this.push(
      "@java.lang.Override\n",
      `public ${className} build() {\n`,
      `return new ${className}(\n`,
    );
    for (const field of fields) {
      const fieldName = namer.structFieldToJavaName(field);
      this.push(`this.${fieldName},\n`);
    }
    this.push("this._u);\n", "}\n\n");
    this.push("}\n\n");

    // Nested classes
    this.writeClassesForNestedRecords(record);
    this.push("}\n\n");
    // TODO
  }

  private writeClassForEnum(
    record: Record,
    nested: "nested" | "top-level",
  ): void {
    const { namer, recordMap, typeSpeller } = this;
    const recordLocation = recordMap.get(record.key)!;
    const className = this.namer.getClassName(recordLocation).name;
    const { fields } = record;
    this.push(
      "public ",
      nested === "nested" ? "static " : "",
      `final class ${className} {\n`,
    );
    this.push("public enum Kind {\n", "UNKNOWN\n", "}\n\n");
    this.push(
      `public static final ${className} UNKNOWN = new ${className}();\n`,
      "public Kind kind() {\n",
      "return Kind.UNKNOWN;\n",
      "}\n\n",
    );
    this.writeClassesForNestedRecords(record);
    this.push("}\n\n");
  }

  private writeClassesForNestedRecords(record: Record): void {
    for (const nestedRecord of record.nestedRecords) {
      this.writeClassForRecord(nestedRecord, "nested");
    }
  }

  get path(): string {
    const { declaration, modulePath } = this;
    let className: string;
    switch (declaration.kind) {
      case "record": {
        const record = this.recordMap.get(declaration.key)!;
        className = this.namer.getClassName(record).name;
        break;
      }
      default:
        // TODO
        className = declaration.name.text;
        break;
    }
    return modulePath.replace(/\.soia$/, "") + `/${className}.java`;
  }

  // private writeClassesForStruct(struct: RecordLocation): void {
  //   const { namer, typeSpeller } = this;
  //   const { recordMap } = typeSpeller;
  //   const { fields } = struct.record;
  //   const className = namer.getClassName(struct);
  //   const { qualifiedName } = className;
  //   this.push(`sealed interface ${className.name}_OrMutable {\n`);
  //   for (const field of fields) {
  //     const fieldName = namer.structFieldToKotlinName(field);
  //     const allRecordsFrozen = field.isRecursive === "hard";
  //     const type = typeSpeller.getKotlinType(
  //       field.type!,
  //       "maybe-mutable",
  //       allRecordsFrozen,
  //     );
  //     this.push(`val ${fieldName}: ${type};\n`);
  //   }
  //   this.push(`\nfun toFrozen(): ${qualifiedName};\n`);
  //   this.push(
  //     "}\n\n", // class _OrMutable
  //     '@kotlin.Suppress("UNUSED_PARAMETER")\n',
  //     `class ${className.name} private constructor(\n`,
  //   );
  //   for (const field of fields) {
  //     const fieldName = namer.structFieldToKotlinName(field);
  //     const type = typeSpeller.getKotlinType(field.type!, "frozen");
  //     if (field.isRecursive === "hard") {
  //       this.push(`private val __${fieldName}: ${type}?,\n`);
  //     } else {
  //       this.push(`override val ${fieldName}: ${type},\n`);
  //     }
  //   }
  //   this.push(
  //     `private val _unrecognizedFields: _UnrecognizedFields<${qualifiedName}>? =\n`,
  //     "null,\n",
  //     `): ${qualifiedName}_OrMutable {\n`,
  //   );
  //   for (const field of fields) {
  //     if (field.isRecursive === "hard") {
  //       const fieldName = namer.structFieldToKotlinName(field);
  //       const defaultExpr = this.getDefaultExpression(field.type!);
  //       this.push(
  //         `override val ${fieldName} get() = __${fieldName} ?: ${defaultExpr};\n`,
  //       );
  //     }
  //   }
  //   this.pushEol();
  //   this.push(
  //     "constructor(\n",
  //     "_mustNameArguments: _MustNameArguments =\n_MustNameArguments,\n",
  //   );
  //   for (const field of fields) {
  //     const fieldName = namer.structFieldToKotlinName(field);
  //     const type = typeSpeller.getKotlinType(field.type!, "initializer");
  //     this.push(`${fieldName}: ${type},\n`);
  //   }
  //   this.push(
  //     `_unrecognizedFields: _UnrecognizedFields<${qualifiedName}>? =\n`,
  //     "null,\n",
  //     "): this(\n",
  //   );
  //   for (const field of fields) {
  //     const fieldName = namer.structFieldToKotlinName(field);
  //     this.push(this.toFrozenExpression(fieldName, field.type!), ",\n");
  //   }
  //   this.push(
  //     "_unrecognizedFields,\n",
  //     ") {}\n\n",
  //     '@kotlin.Deprecated("Already frozen", kotlin.ReplaceWith("this"))\n',
  //     "override fun toFrozen() = this;\n\n",
  //     `fun toMutable() = Mutable(\n`,
  //   );
  //   for (const field of fields) {
  //     const fieldName = namer.structFieldToKotlinName(field);
  //     this.push(`${fieldName} = this.${fieldName},\n`);
  //   }
  //   this.push(");\n\n");

  //   if (fields.length) {
  //     this.push(
  //       "fun copy(\n",
  //       "_mustNameArguments: _MustNameArguments =\n_MustNameArguments,\n",
  //     );
  //     for (const field of fields) {
  //       const fieldName = namer.structFieldToKotlinName(field);
  //       const type = typeSpeller.getKotlinType(field.type!, "initializer");
  //       this.push(`${fieldName}: ${type} =\nthis.${fieldName},\n`);
  //     }
  //     this.push(`) = ${qualifiedName}(\n`);
  //     for (const field of fields) {
  //       const fieldName = namer.structFieldToKotlinName(field);
  //       this.push(this.toFrozenExpression(fieldName, field.type!), ",\n");
  //     }
  //     this.push(
  //       "this._unrecognizedFields,\n",
  //       ");\n\n",
  //       '@kotlin.Deprecated("No point in creating an exact copy of an immutable object", kotlin.ReplaceWith("this"))\n',
  //       "fun copy() = this;\n\n",
  //     );
  //   }
  //   this.push(
  //     "override fun equals(other: kotlin.Any?): kotlin.Boolean {\n",
  //     `return this === other || (other is ${qualifiedName}`,
  //     fields
  //       .map(
  //         (f) =>
  //           ` && this.${namer.structFieldToKotlinName(f)} == other.${namer.structFieldToKotlinName(f)}`,
  //       )
  //       .join(""),
  //     ");\n",
  //     "}\n\n",
  //     "override fun hashCode(): kotlin.Int {\n",
  //     "return kotlin.collections.listOf<kotlin.Any?>(",
  //     fields.map((f) => `this.${namer.structFieldToKotlinName(f)}`).join(", "),
  //     ").hashCode();\n",
  //     "}\n\n",
  //     "override fun toString(): kotlin.String {\n",
  //     "return land.soia.internal.toStringImpl(\n",
  //     "this,\n",
  //     `${qualifiedName}.serializerImpl,\n`,
  //     ")\n",
  //     "}\n\n",
  //   );
  //   this.push(
  //     `class Mutable internal constructor(\n`,
  //     "_mustNameArguments: _MustNameArguments =\n_MustNameArguments,\n",
  //   );
  //   for (const field of fields) {
  //     const fieldName = namer.structFieldToKotlinName(field);
  //     const allRecordsFrozen = !!field.isRecursive;
  //     const type = typeSpeller.getKotlinType(
  //       field.type!,
  //       "maybe-mutable",
  //       allRecordsFrozen,
  //     );
  //     const defaultExpr = this.getDefaultExpression(field.type!);
  //     this.push(`override var ${fieldName}: ${type} =\n${defaultExpr},\n`);
  //   }
  //   this.push(
  //     `internal var _unrecognizedFields: _UnrecognizedFields<${qualifiedName}>? =\n`,
  //     "null,\n",
  //     `): ${qualifiedName}_OrMutable {\n`,
  //     `override fun toFrozen() = ${qualifiedName}(\n`,
  //   );
  //   for (const field of fields) {
  //     const fieldName = namer.structFieldToKotlinName(field);
  //     this.push(`${fieldName} = this.${fieldName},\n`);
  //   }
  //   this.push(
  //     "_unrecognizedFields = this._unrecognizedFields,\n", //
  //     `);\n\n`,
  //   );
  //   this.writeMutableGetters(fields);
  //   this.push(
  //     "}\n\n",
  //     "companion object {\n",
  //     "private val default =\n",
  //     `${qualifiedName}(\n`,
  //   );
  //   for (const field of fields) {
  //     this.push(
  //       field.isRecursive === "hard"
  //         ? "null"
  //         : this.getDefaultExpression(field.type!),
  //       ",\n",
  //     );
  //   }
  //   this.push(
  //     ");\n\n",
  //     "fun partial() = default;\n\n",
  //     "fun partial(\n",
  //     "_mustNameArguments: _MustNameArguments =\n_MustNameArguments,\n",
  //   );
  //   for (const field of fields) {
  //     const fieldName = namer.structFieldToKotlinName(field);
  //     const type = typeSpeller.getKotlinType(field.type!, "initializer");
  //     const defaultExpr = this.getDefaultExpression(field.type!);
  //     this.push(`${fieldName}: ${type} =\n${defaultExpr},\n`);
  //   }
  //   this.push(`) = ${qualifiedName}(\n`);
  //   for (const field of fields) {
  //     const fieldName = namer.structFieldToKotlinName(field);
  //     this.push(`${fieldName} = ${fieldName},\n`);
  //   }
  //   this.push(
  //     "_unrecognizedFields = null,\n",
  //     ");\n\n",
  //     "private val serializerImpl = land.soia.internal.StructSerializer(\n",
  //     `recordId = "${getRecordId(struct)}",\n`,
  //     "defaultInstance = default,\n",
  //     "newMutableFn = { it?.toMutable() ?: Mutable() },\n",
  //     "toFrozenFn = { it.toFrozen() },\n",
  //     "getUnrecognizedFields = { it._unrecognizedFields },\n",
  //     "setUnrecognizedFields = { m, u -> m._unrecognizedFields = u },\n",
  //     ");\n\n",
  //     "val Serializer = land.soia.internal.makeSerializer(serializerImpl);\n\n",
  //     "val TypeDescriptor get() = serializerImpl.typeDescriptor;\n\n",
  //     "init {\n",
  //   );
  //   for (const field of fields) {
  //     const fieldName = namer.structFieldToKotlinName(field);
  //     this.push(
  //       "serializerImpl.addField(\n",
  //       `"${field.name.text}",\n`,
  //       `"${fieldName}",\n`,
  //       `${field.number},\n`,
  //       `${typeSpeller.getSerializerExpression(field.type!)},\n`,
  //       `{ it.${fieldName} },\n`,
  //       `{ mut, v -> mut.${fieldName} = v },\n`,
  //       ");\n",
  //     );
  //   }
  //   for (const removedNumber of struct.record.removedNumbers) {
  //     this.push(`serializerImpl.addRemovedNumber(${removedNumber});\n`);
  //   }
  //   this.push("serializerImpl.finalizeStruct();\n", "}\n", "}\n");

  //   // Write the classes for the records nested in `record`.
  //   const nestedRecords = struct.record.nestedRecords.map(
  //     (r) => recordMap.get(r.key)!,
  //   );
  //   this.writeClassesForRecords(nestedRecords);

  //   this.push("}\n\n");
  // }

  // private writeMutableGetters(fields: readonly Field[]): void {
  //   const { namer, typeSpeller } = this;
  //   for (const field of fields) {
  //     if (field.isRecursive) {
  //       continue;
  //     }
  //     const type = field.type!;
  //     const fieldName = namer.structFieldToKotlinName(field);
  //     const mutableGetterName =
  //       "mutable" +
  //       convertCase(field.name.text, "lower_underscore", "UpperCamel");
  //     const mutableType = typeSpeller.getKotlinType(field.type!, "mutable");
  //     const accessor = `this.${fieldName}`;
  //     let bodyLines: string[] = [];
  //     if (type.kind === "array") {
  //       bodyLines = [
  //         "return when (value) {\n",
  //         "is land.soia.internal.MutableList -> value;\n",
  //         "else -> {\n",
  //         "value = land.soia.internal.MutableList(value);\n",
  //         `${accessor} = value;\n`,
  //         "value;\n",
  //         "}\n",
  //         "}\n",
  //       ];
  //     } else if (type.kind === "record") {
  //       const record = this.typeSpeller.recordMap.get(type.key)!;
  //       if (record.record.recordType === "struct") {
  //         const structQualifiedName = namer.getClassName(record).qualifiedName;
  //         bodyLines = [
  //           "return when (value) {\n",
  //           `is ${structQualifiedName} -> {\n`,
  //           "value = value.toMutable();\n",
  //           `${accessor} = value;\n`,
  //           "return value;\n",
  //           "}\n",
  //           `is ${structQualifiedName}.Mutable -> value;\n`,
  //           "}\n",
  //         ];
  //       }
  //     }
  //     if (bodyLines.length) {
  //       this.push(
  //         `val ${mutableGetterName}: ${mutableType} get() {\n`,
  //         `var value = ${accessor};\n`,
  //       );
  //       for (const line of bodyLines) {
  //         this.push(line);
  //       }
  //       this.push("}\n\n");
  //     }
  //   }
  // }

  // private writeClassForEnum(record: RecordLocation): void {
  //   const { namer, typeSpeller } = this;
  //   const { recordMap } = typeSpeller;
  //   const { fields } = record.record;
  //   const constantFields = fields.filter((f) => !f.type);
  //   const wrapperFields = fields.filter((f) => f.type);
  //   const className = namer.getClassName(record);
  //   const qualifiedName = className.qualifiedName;
  //   this.push(
  //     `sealed class ${className.name} private constructor() {\n`,
  //     "enum class Kind {\n", //
  //     "UNKNOWN,\n",
  //   );
  //   for (const field of constantFields) {
  //     this.push(`${field.name.text}_CONST,\n`);
  //   }
  //   for (const field of wrapperFields) {
  //     this.push(
  //       convertCase(field.name.text, "lower_underscore", "UPPER_UNDERSCORE"),
  //       "_WRAPPER,\n",
  //     );
  //   }
  //   this.push(
  //     "}\n\n",
  //     'class Unknown @kotlin.Deprecated("For internal use", kotlin.ReplaceWith("',
  //     qualifiedName,
  //     '.UNKNOWN")) internal constructor(\n',
  //     `internal val _unrecognized: _UnrecognizedEnum<${qualifiedName}>?,\n`,
  //     `) : ${qualifiedName}() {\n`,
  //     "override val kind get() = Kind.UNKNOWN;\n\n",
  //     "override fun equals(other: kotlin.Any?): kotlin.Boolean {\n",
  //     "return other is Unknown;\n",
  //     "}\n\n",
  //     "override fun hashCode(): kotlin.Int {\n",
  //     "return -900601970;\n",
  //     "}\n\n",
  //     "}\n\n", // class Unknown
  //   );
  //   for (const constField of constantFields) {
  //     const kindExpr = `Kind.${constField.name.text}_CONST`;
  //     const constantName = toEnumConstantName(constField);
  //     this.push(
  //       `object ${constantName} : ${qualifiedName}() {\n`,
  //       `override val kind get() = ${kindExpr};\n\n`,
  //       "init {\n",
  //       "_maybeFinalizeSerializer();\n",
  //       "}\n",
  //       `}\n\n`, // object
  //     );
  //   }
  //   for (const wrapperField of wrapperFields) {
  //     const valueType = wrapperField.type!;
  //     const wrapperClassName =
  //       convertCase(wrapperField.name.text, "lower_underscore", "UpperCamel") +
  //       "Wrapper";
  //     const initializerType = typeSpeller
  //       .getKotlinType(valueType, "initializer")
  //       .toString();
  //     const frozenType = typeSpeller
  //       .getKotlinType(valueType, "frozen")
  //       .toString();
  //     this.pushEol();
  //     if (initializerType === frozenType) {
  //       this.push(
  //         `class ${wrapperClassName}(\n`,
  //         `val value: ${initializerType},\n`,
  //         `) : ${qualifiedName}() {\n`,
  //       );
  //     } else {
  //       this.push(
  //         `class ${wrapperClassName} private constructor (\n`,
  //         `val value: ${frozenType},\n`,
  //         `) : ${qualifiedName}() {\n`,
  //         "constructor(\n",
  //         `value: ${initializerType},\n`,
  //         `): this(${this.toFrozenExpression("value", valueType)}) {}\n\n`,
  //       );
  //     }
  //     const kindExpr =
  //       "Kind." +
  //       convertCase(
  //         wrapperField.name.text,
  //         "lower_underscore",
  //         "UPPER_UNDERSCORE",
  //       ) +
  //       "_WRAPPER";
  //     this.push(
  //       `override val kind get() = ${kindExpr};\n\n`,
  //       "override fun equals(other: kotlin.Any?): kotlin.Boolean {\n",
  //       `return other is ${qualifiedName}.${wrapperClassName} && value == other.value;\n`,
  //       "}\n\n",
  //       "override fun hashCode(): kotlin.Int {\n",
  //       "return this.value.hashCode() + ",
  //       String(simpleHash(wrapperField.name.text) | 0),
  //       ";\n",
  //       "}\n\n",
  //       "}\n\n", // class
  //     );
  //   }

  //   this.push(
  //     "abstract val kind: Kind;\n\n",
  //     "override fun toString(): kotlin.String {\n",
  //     "return land.soia.internal.toStringImpl(\n",
  //     "this,\n",
  //     `${qualifiedName}._serializerImpl,\n`,
  //     ")\n",
  //     "}\n\n",
  //     "companion object {\n",
  //     'val UNKNOWN = @kotlin.Suppress("DEPRECATION") Unknown(null);\n\n',
  //   );
  //   for (const wrapperField of wrapperFields) {
  //     const type = wrapperField.type!;
  //     if (type.kind !== "record") {
  //       continue;
  //     }
  //     const structLocation = typeSpeller.recordMap.get(type.key)!;
  //     const struct = structLocation.record;
  //     if (struct.recordType !== "struct") {
  //       continue;
  //     }
  //     const structClassName = namer.getClassName(structLocation);
  //     const createFunName =
  //       "create" +
  //       convertCase(wrapperField.name.text, "lower_underscore", "UpperCamel");
  //     const wrapperClassName =
  //       convertCase(wrapperField.name.text, "lower_underscore", "UpperCamel") +
  //       "Wrapper";
  //     this.push(
  //       '@kotlin.Suppress("UNUSED_PARAMETER")\n',
  //       `fun ${createFunName}(\n`,
  //       "_mustNameArguments: _MustNameArguments =\n_MustNameArguments,\n",
  //     );
  //     for (const field of struct.fields) {
  //       const fieldName = namer.structFieldToKotlinName(field);
  //       const type = typeSpeller.getKotlinType(field.type!, "initializer");
  //       this.push(`${fieldName}: ${type},\n`);
  //     }
  //     this.push(
  //       `) = ${wrapperClassName}(\n`,
  //       `${structClassName.qualifiedName}(\n`,
  //     );
  //     for (const field of struct.fields) {
  //       const fieldName = namer.structFieldToKotlinName(field);
  //       this.push(`${fieldName} = ${fieldName},\n`);
  //     }
  //     this.push(")\n", ");\n\n");
  //   }
  //   this.push(
  //     "private val _serializerImpl =\n",
  //     `land.soia.internal.EnumSerializer.create<${qualifiedName}, Unknown>(\n`,
  //     `recordId = "${getRecordId(record)}",\n`,
  //     "unknownInstance = UNKNOWN,\n",
  //     'wrapUnrecognized = { @kotlin.Suppress("DEPRECATION") Unknown(it) },\n',
  //     "getUnrecognized = { it._unrecognized },\n)",
  //     ";\n\n",
  //     "val Serializer = land.soia.internal.makeSerializer(_serializerImpl);\n\n",
  //     "val TypeDescriptor get() = _serializerImpl.typeDescriptor;\n\n",
  //     "init {\n",
  //   );
  //   for (const constField of constantFields) {
  //     this.push(toEnumConstantName(constField), ";\n");
  //   }
  //   this.push("_maybeFinalizeSerializer();\n");
  //   this.push(
  //     "}\n\n", // init
  //     `private var _finalizationCounter = 0;\n\n`,
  //     "private fun _maybeFinalizeSerializer() {\n",
  //     "_finalizationCounter += 1;\n",
  //     `if (_finalizationCounter == ${constantFields.length + 1}) {\n`,
  //   );
  //   for (const constField of constantFields) {
  //     this.push(
  //       "_serializerImpl.addConstantField(\n",
  //       `${constField.number},\n`,
  //       `"${constField.name.text}",\n`,
  //       `${toEnumConstantName(constField)},\n`,
  //       ");\n",
  //     );
  //   }
  //   for (const wrapperField of wrapperFields) {
  //     const serializerExpression = typeSpeller.getSerializerExpression(
  //       wrapperField.type!,
  //     );
  //     const wrapperClassName =
  //       convertCase(wrapperField.name.text, "lower_underscore", "UpperCamel") +
  //       "Wrapper";
  //     this.push(
  //       "_serializerImpl.addWrapperField(\n",
  //       `${wrapperField.number},\n`,
  //       `"${wrapperField.name.text}",\n`,
  //       `${wrapperClassName}::class.java,\n`,
  //       `${serializerExpression},\n`,
  //       `{ ${wrapperClassName}(it) },\n`,
  //       ") { it.value };\n",
  //     );
  //   }
  //   for (const removedNumber of record.record.removedNumbers) {
  //     this.push(`_serializerImpl.addRemovedNumber(${removedNumber});\n`);
  //   }
  //   this.push(
  //     "_serializerImpl.finalizeEnum();\n",
  //     "}\n",
  //     "}\n", // maybeFinalizeSerializer
  //     "}\n\n", // companion object
  //   );

  //   // Write the classes for the records nested in `record`.
  //   const nestedRecords = record.record.nestedRecords.map(
  //     (r) => recordMap.get(r.key)!,
  //   );
  //   this.writeClassesForRecords(nestedRecords);
  //   this.push("}\n\n");
  // }

  // private writeMethod(method: Method): void {
  //   const { typeSpeller } = this;
  //   const methodName = method.name.text;
  //   const requestType = typeSpeller.getKotlinType(
  //     method.requestType!,
  //     "frozen",
  //   );
  //   const requestSerializerExpr = typeSpeller.getSerializerExpression(
  //     method.requestType!,
  //   );
  //   const responseType = typeSpeller.getKotlinType(
  //     method.responseType!,
  //     "frozen",
  //   );
  //   const responseSerializerExpr = typeSpeller.getSerializerExpression(
  //     method.responseType!,
  //   );
  //   this.push(
  //     `val ${methodName}: land.soia.Method<\n${requestType},\n${responseType},\n> by kotlin.lazy {\n`,
  //     "land.soia.Method(\n",
  //     `"${methodName}",\n`,
  //     `${method.number},\n`,
  //     requestSerializerExpr + ",\n",
  //     responseSerializerExpr + ",\n",
  //     ")\n",
  //     "}\n\n",
  //   );
  // }

  // private writeConstant(constant: Constant): void {
  //   const { typeSpeller } = this;
  //   const name = constant.name.text;
  //   const type = constant.type!;
  //   const kotlinType = typeSpeller.getKotlinType(constant.type!, "frozen");
  //   const tryGetKotlinConstLiteral: () => string | undefined = () => {
  //     if (type.kind !== "primitive") {
  //       return undefined;
  //     }
  //     const { valueAsDenseJson } = constant;
  //     switch (type.primitive) {
  //       case "bool":
  //         return JSON.stringify(!!valueAsDenseJson);
  //       case "int32":
  //       case "string":
  //         return JSON.stringify(valueAsDenseJson);
  //       case "int64":
  //         return `${valueAsDenseJson}L`;
  //       case "uint64":
  //         return `${valueAsDenseJson}UL`;
  //       case "float32": {
  //         if (valueAsDenseJson === "NaN") {
  //           return "Float.NaN";
  //         } else if (valueAsDenseJson === "Infinity") {
  //           return "Float.POSITIVE_INFINITY";
  //         } else if (valueAsDenseJson === "-Infinity") {
  //           return "Float.NEGATIVE_INFINITY";
  //         } else {
  //           return JSON.stringify(valueAsDenseJson) + "F";
  //         }
  //       }
  //       case "float64": {
  //         if (valueAsDenseJson === "NaN") {
  //           return "Double.NaN";
  //         } else if (valueAsDenseJson === "Infinity") {
  //           return "Double.POSITIVE_INFINITY";
  //         } else if (valueAsDenseJson === "-Infinity") {
  //           return "Double.NEGATIVE_INFINITY";
  //         } else {
  //           return JSON.stringify(valueAsDenseJson);
  //         }
  //       }
  //       default:
  //         return undefined;
  //     }
  //   };
  //   const kotlinConstLiteral = tryGetKotlinConstLiteral();
  //   if (kotlinConstLiteral !== undefined) {
  //     this.push(
  //       `const val ${name}: ${kotlinType} = ${kotlinConstLiteral};\n\n`,
  //     );
  //   } else {
  //     const serializerExpression = typeSpeller.getSerializerExpression(
  //       constant.type!,
  //     );
  //     const jsonStringLiteral = JSON.stringify(
  //       JSON.stringify(constant.valueAsDenseJson),
  //     );
  //     this.push(
  //       `val ${name}: ${kotlinType} by kotlin.lazy {\n`,
  //       serializerExpression,
  //       `.fromJsonCode(${jsonStringLiteral})\n`,
  //       "}\n\n",
  //     );
  //   }
  // }

  private getDefaultExpression(type: ResolvedType): string {
    switch (type.kind) {
      case "primitive": {
        switch (type.primitive) {
          case "bool":
            return "false";
          case "int32":
          case "int64":
          case "uint64":
            return "0";
          case "float32":
            return "0.0f";
          case "float64":
            return "0.0";
          case "timestamp":
            return "java.time.Instant.EPOCH";
          case "string":
            return '""';
          case "bytes":
            return "okio.ByteString.EMPTY";
          default: {
            const _: never = type.primitive;
            throw Error();
          }
        }
      }
      case "array": {
        if (type.key) {
          return `land.soia.internal.FrozenListKt.emptyKeyedList()`;
        } else {
          return `land.soia.internal.FrozenListKt.emptyFrozenList()`;
        }
      }
      case "optional": {
        return "java.util.Optional.empty()";
      }
      case "record": {
        const record = this.typeSpeller.recordMap.get(type.key)!;
        const kotlinType = this.typeSpeller.getJavaType(type, "frozen");
        switch (record.record.recordType) {
          case "struct": {
            return `${kotlinType}.DEFAULT`;
          }
          case "enum": {
            return `${kotlinType}.UNKNOWN`;
          }
        }
        break;
      }
    }
  }

  private toFrozenExpression(
    inputExpr: string,
    type: ResolvedType,
    nullability: "can-be-null" | "never-null",
    it: string,
  ): string {
    const { namer } = this;
    switch (type.kind) {
      case "primitive": {
        switch (type.primitive) {
          case "bool":
          case "int32":
          case "int64":
          case "uint64":
          case "float32":
          case "float64":
            return inputExpr;
          case "timestamp":
          case "string":
          case "bytes":
            return nullability === "can-be-null"
              ? `java.util.Objects.requireNonNull(${inputExpr})`
              : inputExpr;
          default: {
            const _: never = type.primitive;
            throw Error();
          }
        }
      }
      case "array": {
        const itemToFrozenExpr = this.toFrozenExpression(
          it,
          type.item,
          "can-be-null",
          it + "_",
        );
        const frozenListKt = "land.soia.internal.FrozenListKt";
        if (type.key) {
          const path = type.key.path
            .map((f) => namer.structFieldToJavaName(f.name.text) + "()")
            .join(".");
          if (itemToFrozenExpr === it) {
            return `${frozenListKt}.toKeyedList(\n${inputExpr},\n"${path}",\n(${it}) -> ${it}.${path}\n)`;
          } else {
            return `${frozenListKt}.toKeyedList(\n${inputExpr},\n"${path}",\n(${it}) -> ${it}.${path},\n(${it}) -> ${itemToFrozenExpr}\n)`;
          }
        } else {
          if (itemToFrozenExpr === it) {
            return `${frozenListKt}.toFrozenList(${inputExpr})`;
          } else {
            return `${frozenListKt}.toFrozenList(\n${inputExpr},\n(${it}) -> ${itemToFrozenExpr}\n)`;
          }
        }
      }
      case "optional": {
        const otherExpr = this.toFrozenExpression(
          it,
          type.other,
          "never-null",
          it + "_",
        );
        return `${inputExpr}.map(\n(${it}) -> ${otherExpr}\n)`;
      }
      case "record": {
        return nullability === "can-be-null"
          ? `java.util.Objects.requireNonNull(${inputExpr})`
          : inputExpr;
      }
    }
  }

  private push(...code: string[]): void {
    this.code += code.join("");
  }

  private pushEol(): void {
    this.code += "\n";
  }

  private joinLinesAndFixFormatting(): string {
    const indentUnit = "  ";
    let result = "";
    // The indent at every line is obtained by repeating indentUnit N times,
    // where N is the length of this array.
    const contextStack: Array<"{" | "(" | "[" | "<" | ":" | "."> = [];
    // Returns the last element in `contextStack`.
    const peakTop = (): string => contextStack.at(-1)!;
    const getMatchingLeftBracket = (r: "}" | ")" | "]" | ">"): string => {
      switch (r) {
        case "}":
          return "{";
        case ")":
          return "(";
        case "]":
          return "[";
        case ">":
          return "<";
      }
    };
    for (let line of this.code.split("\n")) {
      line = line.trim();
      if (line.length <= 0) {
        // Don't indent empty lines.
        result += "\n";
        continue;
      }

      const firstChar = line[0];
      switch (firstChar) {
        case "}":
        case ")":
        case "]":
        case ">": {
          const left = getMatchingLeftBracket(firstChar);
          while (contextStack.pop() !== left) {
            if (contextStack.length <= 0) {
              throw Error();
            }
          }
          break;
        }
        case ".": {
          if (peakTop() !== ".") {
            contextStack.push(".");
          }
          break;
        }
      }
      const indent = indentUnit.repeat(contextStack.length);
      result += `${indent}${line.trimEnd()}\n`;
      if (line.startsWith("//")) {
        continue;
      }
      const lastChar = line.slice(-1);
      switch (lastChar) {
        case "{":
        case "(":
        case "[":
        case "<": {
          // The next line will be indented
          contextStack.push(lastChar);
          break;
        }
        case ":":
        case "=": {
          if (peakTop() !== ":") {
            contextStack.push(":");
          }
          break;
        }
        case ";":
        case ",": {
          if (peakTop() === "." || peakTop() === ":") {
            contextStack.pop();
          }
        }
      }
    }

    return (
      result
        // Remove spaces enclosed within curly brackets if that's all there is.
        .replace(/\{\s+\}/g, "{}")
        // Remove spaces enclosed within round brackets if that's all there is.
        .replace(/\(\s+\)/g, "()")
        // Remove spaces enclosed within square brackets if that's all there is.
        .replace(/\[\s+\]/g, "[]")
        // Remove empty line following an open curly bracket.
        .replace(/(\{\n *)\n/g, "$1")
        // Remove empty line preceding a closed curly bracket.
        .replace(/\n(\n *\})/g, "$1")
        // Coalesce consecutive empty lines.
        .replace(/\n\n\n+/g, "\n\n")
        .replace(/\n\n$/g, "\n")
    );
  }

  private readonly typeSpeller: TypeSpeller;
  private readonly packagePrefix: string;
  private readonly namer: Namer;
  private code = "";
}

export const GENERATOR = new JavaCodeGenerator();
