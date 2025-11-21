// TODO: upgrade client lib, update kotlin gen, remove typeDescriptor method...
// TODO: fix name conflicts in 'naming.ts'
// TODO: golden tests

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
import { Namer, toEnumConstantName } from "./naming.js";
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
    const javaSourceFiles: JavaSourceFileGenerator[] = [];
    for (const module of input.modules) {
      for (const record of module.records) {
        if (record.recordAncestors.length !== 1) {
          // Only consider top-level records
          continue;
        }
        javaSourceFiles.push(
          new JavaSourceFileGenerator(
            record.record,
            module.path,
            recordMap,
            config,
          ),
        );
      }
      if (module.methods.length > 0) {
        javaSourceFiles.push(
          new JavaSourceFileGenerator(
            {
              kind: "methods",
              methods: module.methods,
            },
            module.path,
            recordMap,
            config,
          ),
        );
      }
      if (module.constants.length > 0) {
        javaSourceFiles.push(
          new JavaSourceFileGenerator(
            {
              kind: "constants",
              constants: module.constants,
            },
            module.path,
            recordMap,
            config,
          ),
        );
      }
    }
    const outputFiles = javaSourceFiles.map((sourceFile) => ({
      path: sourceFile.path,
      code: sourceFile.generate(),
    }));
    return { files: outputFiles };
  }
}

type JavaSourceFileTarget =
  | Record
  | {
      kind: "methods";
      methods: readonly Method[];
    }
  | {
      kind: "constants";
      constants: readonly Constant[];
    };

// Generates the code for one Java file.
class JavaSourceFileGenerator {
  constructor(
    private readonly target: JavaSourceFileTarget,
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
      // to your build.gradle file

      `,
      `package ${this.packagePrefix}soiagen.`,
      this.modulePath.replace(/\.soia$/, "").replace("/", "."),
      ";\n\n",
    );

    const { target } = this;
    switch (target.kind) {
      case "record": {
        this.writeClassForRecord(target, "top-level");
        break;
      }
      case "methods": {
        this.writeClassForMethods(target.methods);
        break;
      }
      case "constants": {
        this.writeClassForConstants(target.constants);
        break;
      }
      default: {
        const _: never = target;
      }
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

    // toBuilder()
    this.push(`public Builder toBuilder() {\n`);
    this.push(`return new Builder(\n`);
    for (const field of fields) {
      const fieldName = namer.structFieldToJavaName(field);
      this.push(`this.${fieldName},\n`);
    }
    this.push("this._u);\n", "}\n\n");

    // equals()
    this.push(
      "@java.lang.Override\n",
      "public boolean equals(Object other) {\n",
      "if (this == other) return true;\n",
      `if (!(other instanceof ${className})) return false;\n`,
      `return java.util.Arrays.equals(_equalsProxy(), ((${className}) other)._equalsProxy());\n`,
      "}\n\n",
    );

    // hashCode()
    this.push(
      "@java.lang.Override\n",
      "public int hashCode() {\n",
      "return java.util.Arrays.hashCode(_equalsProxy());\n",
      "}\n\n",
    );

    // toString()
    this.push(
      "@java.lang.Override\n",
      "public java.lang.String toString() {\n",
      `return SERIALIZER.toJsonCode(this, land.soia.JsonFlavor.READABLE);\n`,
      "}\n\n",
    );

    // _equalsProxy()
    this.push(
      "private Object[] _equalsProxy() {\n",
      "return new Object[] {\n",
      fields
        .map((field) => "this." + namer.structFieldToJavaName(field))
        .join(",\n"),
      "\n};\n",
      "}\n\n",
    );

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

    // Builder fields
    for (const field of fields) {
      const fieldName = namer.structFieldToJavaName(field);
      const type = typeSpeller.getJavaType(field.type!, "frozen");
      this.push(`private ${type} ${fieldName};\n`);
    }
    this.push(`private ${unrecognizedFieldsType} _u;\n\n`);

    // Builder constructors
    this.push("private Builder(\n");
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

    // _serializerImpl
    {
      const serializerType = `land.soia.internal.StructSerializer<${className}, ${className}.Builder>`;
      this.push(
        `private static final ${serializerType} _serializerImpl = (\n`,
        "new land.soia.internal.StructSerializer<>(\n",
        `"${getRecordId(recordLocation)}",\n`,
        "DEFAULT,\n",
        `(${className} it) -> it != null ? it.toBuilder() : partialBuilder(),\n`,
        `(${className}.Builder it) -> it.build(),\n`,
        `(${className} it) -> it._u,\n`,
        `(${className}.Builder builder, ${unrecognizedFieldsType} u) -> {\n`,
        `builder._u = u;\n`,
        "return null;\n",
        "}\n",
        ")\n",
        ");\n\n",
      );
    }

    // SERIALIZER
    this.push(
      `public static final land.soia.Serializer<${className}> SERIALIZER = (\n`,
      "land.soia.internal.SerializersKt.makeSerializer(_serializerImpl)\n",
      ");\n\n",
    );

    // TYPE_DESCRIPTOR
    {
      const typeDescriptorType = `land.soia.reflection.StructDescriptor.Reflective<${className}, ${className}.Builder>`;
      this.push(
        `public static final ${typeDescriptorType} TYPE_DESCRIPTOR = (\n`,
        "_serializerImpl\n",
        ");\n\n",
      );
    }

    // Finalize serializer
    this.push("static {\n");
    for (const field of fields) {
      const soiaName = field.name.text;
      const javadName = namer.structFieldToJavaName(field);
      this.push(
        "_serializerImpl.addField(\n",
        `"${soiaName}",\n`,
        '"",\n',
        `${field.number},\n`,
        `${typeSpeller.getSerializerExpression(field.type!)},\n`,
        `(it) -> it.${javadName},\n`,
        "(builder, v) -> {\n",
        `builder.${javadName} = v;\n`,
        "return null;\n",
        "}\n",
        ");\n",
      );
    }
    for (const removedNumber of record.removedNumbers) {
      this.push(`_serializerImpl.addRemovedNumber(${removedNumber});\n`);
    }
    this.push("_serializerImpl.finalizeStruct();\n", "}\n\n");

    // Nested classes
    this.writeClassesForNestedRecords(record);
    this.push("}\n\n");
  }

  private writeClassForEnum(
    record: Record,
    nested: "nested" | "top-level",
  ): void {
    const { recordMap, typeSpeller } = this;
    const recordLocation = recordMap.get(record.key)!;
    const className = this.namer.getClassName(recordLocation).name;
    const { fields } = record;
    const constantFields = fields.filter((f) => !f.type);
    const wrapperFields = fields.filter((f) => f.type);
    this.push(
      "public ",
      nested === "nested" ? "static " : "",
      `final class ${className} {\n`,
    );
    // Kind enum
    this.push("public enum Kind {\n", "UNKNOWN,\n");
    for (const field of constantFields) {
      this.push(field.name.text, "_CONST,\n");
    }
    for (const field of wrapperFields) {
      this.push(
        convertCase(field.name.text, "lower_underscore", "UPPER_UNDERSCORE"),
        "_WRAPPER,\n",
      );
    }
    this.push("}\n\n");

    // Constants
    this.push(
      `public static final ${className} UNKNOWN = new ${className}(Kind.UNKNOWN, null);\n`,
    );
    for (const field of constantFields) {
      const soiaName = field.name.text;
      const name = toEnumConstantName(field);
      this.push(
        `public static final ${className} ${name} = new ${className}(Kind.${soiaName}_CONST, null);\n`,
      );
    }
    this.pushEol();

    // WrapX methods
    for (const field of wrapperFields) {
      const upperCamelName = convertCase(
        field.name.text,
        "lower_underscore",
        "UpperCamel",
      );
      const upperUnderscoreName = convertCase(
        field.name.text,
        "lower_underscore",
        "UPPER_UNDERSCORE",
      );
      const type = field.type!;
      const initializerType = typeSpeller.getJavaType(type, "initializer");
      const frozenType = typeSpeller.getJavaType(type, "frozen");
      const toFrozenExpr = this.toFrozenExpression(
        "value",
        type,
        "can-be-null",
        "_e",
      );
      this.push(
        `public static ${className} wrap${upperCamelName}(${initializerType} value) {\n`,
        `final ${frozenType} v = ${toFrozenExpr};\n`,
        `return new ${className}(Kind.${upperUnderscoreName}_WRAPPER, v);\n`,
        "}\n\n",
      );
    }

    // Declare fields
    this.push(
      "private final Kind kind;\n",
      "private final java.lang.Object value;\n\n",
    );

    // Constructor
    this.push(
      `private ${className}(Kind kind, java.lang.Object value) {\n`,
      "this.kind = kind;\n",
      "this.value = value;\n",
      "}\n\n",
    );

    // kind()
    this.push("public Kind kind() {\n", "return kind;\n", "}\n\n");

    // asX() methods
    for (const field of wrapperFields) {
      const type = typeSpeller.getJavaType(field.type!, "frozen");
      const upperCamelName = convertCase(
        field.name.text,
        "lower_underscore",
        "UpperCamel",
      );
      const upperUnderscoreName = convertCase(
        field.name.text,
        "lower_underscore",
        "UPPER_UNDERSCORE",
      );
      this.push(
        `public ${type} as${upperCamelName}() {\n`,
        `if (kind != Kind.${upperUnderscoreName}_WRAPPER) {\n`,
        `throw new java.lang.IllegalStateException("kind=" + kind.name());\n`,
        "}\n",
        `return (${type}) value;\n`,
        "}\n\n",
      );
    }

    // Visitor
    this.push("public interface Visitor<R> {\n", "R onUnknown();\n");
    for (const field of constantFields) {
      const upperCamelName = convertCase(
        field.name.text,
        "UPPER_UNDERSCORE",
        "UpperCamel",
      );
      this.push(`R on${upperCamelName}();\n`);
    }
    for (const field of wrapperFields) {
      const upperCamelName = convertCase(
        field.name.text,
        "lower_underscore",
        "UpperCamel",
      );
      const type = typeSpeller.getJavaType(field.type!, "frozen");
      this.push(`R on${upperCamelName}(${type} value);\n`);
    }
    this.push("}\n\n");

    // accept()
    this.push(
      "public <R> R accept(Visitor<R> visitor) {\n",
      "return switch (kind) {\n",
    );
    for (const field of constantFields) {
      const upperUnderscoreName = field.name.text;
      const upperCamelName = convertCase(
        field.name.text,
        "UPPER_UNDERSCORE",
        "UpperCamel",
      );
      this.push(
        `case ${upperUnderscoreName}_CONST -> visitor.on${upperCamelName}();\n`,
      );
    }
    for (const field of wrapperFields) {
      const upperUnderscoreName = convertCase(
        field.name.text,
        "lower_underscore",
        "UPPER_UNDERSCORE",
      );
      const upperCamelName = convertCase(
        field.name.text,
        "lower_underscore",
        "UpperCamel",
      );
      const type = typeSpeller.getJavaType(field.type!, "frozen");
      this.push(
        `case ${upperUnderscoreName}_WRAPPER -> visitor.on${upperCamelName}((${type}) value);\n`,
      );
    }
    this.push("default -> visitor.onUnknown();\n", "};\n", "}\n\n");

    // equals()
    this.push(
      "@java.lang.Override\n",
      "public boolean equals(Object other) {\n",
      `if (!(other instanceof ${className})) return false;\n`,
      `final ${className} otherEnum = (${className}) other;\n`,
      "if (kind == Kind.UNKNOWN) return otherEnum.kind == Kind.UNKNOWN;\n",
      "return kind == otherEnum.kind && java.util.Objects.equals(value, otherEnum.value);\n",
      "}\n\n",
    );

    // hashCode()
    this.push(
      "@java.lang.Override\n",
      "public int hashCode() {\n",
      "final Object v = kind == Kind.UNKNOWN ? null : value;\n",
      "return 31 * java.util.Objects.hashCode(v) + kind.ordinal();\n",
      "}\n\n",
    );

    // toString()
    this.push(
      "@java.lang.Override\n",
      "public java.lang.String toString() {\n",
      `return SERIALIZER.toJsonCode(this, land.soia.JsonFlavor.READABLE);\n`,
      "}\n\n",
    );

    // _serializerImpl
    {
      const serializerType = `land.soia.internal.EnumSerializer<${className}>`;
      const unrecognizedEnumType = `land.soia.internal.UnrecognizedEnum<${className}>`;
      this.push(
        `private static final ${serializerType} _serializerImpl = (\n`,
        "land.soia.internal.EnumSerializer.Companion.create(\n",
        `"${getRecordId(recordLocation)}",\n`,
        `(${className} it) -> it.kind().ordinal(),\n`,
        "Kind.values().length,\n",
        "UNKNOWN,\n",
        `(${unrecognizedEnumType} it) -> new ${className}(Kind.UNKNOWN, it),\n`,
        `(${className} it) -> (${unrecognizedEnumType}) it.value\n`,
        ")\n",
        ");\n\n",
      );
    }

    // SERIALIZER
    this.push(
      `public static final land.soia.Serializer<${className}> SERIALIZER = (\n`,
      "land.soia.internal.SerializersKt.makeSerializer(_serializerImpl)\n",
      ");\n\n",
    );

    // TYPE_DESCRIPTOR
    {
      const typeDescriptorType = `land.soia.reflection.EnumDescriptor.Reflective<${className}>`;
      this.push(
        `public static final ${typeDescriptorType} TYPE_DESCRIPTOR = (\n`,
        "_serializerImpl\n",
        ");\n\n",
      );
    }

    // Finalize serializer
    this.push("static {\n");
    for (const field of constantFields) {
      const name = field.name.text;
      this.push(
        "_serializerImpl.addConstantField(\n",
        `${field.number},\n`,
        `"${name}",\n`,
        `Kind.${name}_CONST.ordinal(),\n`,
        `${toEnumConstantName(field)}\n`,
        ");\n",
      );
    }
    for (const field of wrapperFields) {
      const type = field.type!;
      const javaType = typeSpeller.getJavaType(
        type,
        "frozen",
        "must-be-object",
      );
      const serializerExpression = typeSpeller.getSerializerExpression(type);
      const soiaName = field.name.text;
      const upperCamelName = convertCase(
        soiaName,
        "lower_underscore",
        "UpperCamel",
      );
      const kindConstName =
        convertCase(soiaName, "lower_underscore", "UPPER_UNDERSCORE") +
        "_WRAPPER";
      this.push(
        "_serializerImpl.addWrapperField(\n",
        `${field.number},\n`,
        `"${field.name.text}",\n`,
        `Kind.${kindConstName}.ordinal(),\n`,
        `${serializerExpression},\n`,
        `(${javaType} it) -> wrap${upperCamelName}(it),\n`,
        `(${className} it) -> it.as${upperCamelName}()\n`,
        ");\n",
      );
    }
    for (const removedNumber of record.removedNumbers) {
      this.push(`_serializerImpl.addRemovedNumber(${removedNumber});\n`);
    }
    this.push("_serializerImpl.finalizeEnum();\n", "}\n\n");

    // Nested classes
    this.writeClassesForNestedRecords(record);
    this.push("}\n\n");
  }

  private writeClassesForNestedRecords(record: Record): void {
    for (const nestedRecord of record.nestedRecords) {
      this.writeClassForRecord(nestedRecord, "nested");
    }
  }

  get path(): string {
    const { target, modulePath } = this;
    let className: string;
    switch (target.kind) {
      case "record": {
        const record = this.recordMap.get(target.key)!;
        className = this.namer.getClassName(record).name;
        break;
      }
      case "methods": {
        className = "Methods";
        break;
      }
      case "constants": {
        className = "Constants";
        break;
      }
    }
    return modulePath.replace(/\.soia$/, "") + `/${className}.java`;
  }

  private writeClassForMethods(methods: readonly Method[]): void {
    this.push("public final class Methods {\n\n", "private Methods() {}\n\n");
    for (const method of methods) {
      this.writeMethod(method);
    }
    this.push("}\n\n");
  }

  private writeMethod(method: Method): void {
    const { typeSpeller } = this;
    const requestType = typeSpeller.getJavaType(method.requestType!, "frozen");
    const requestSerializer = typeSpeller.getSerializerExpression(
      method.requestType!,
    );
    const responseType = typeSpeller.getJavaType(
      method.responseType!,
      "frozen",
    );
    const responseSerializer = typeSpeller.getSerializerExpression(
      method.responseType!,
    );

    const soiaName = method.name.text;
    const javaName = convertCase(
      soiaName,
      "lower_underscore",
      "UPPER_UNDERSCORE",
    );

    const methodType = `land.soia.service.Method<${requestType}, ${responseType}>`;
    this.push(
      `public static final ${methodType} ${javaName} = (\n`,
      "new land.soia.service.Method<>(\n",
      `"${soiaName}",\n`,
      `${method.number},\n`,
      `${requestSerializer},\n`,
      `${responseSerializer}\n`,
      ")\n",
      ");\n\n",
    );
  }

  private writeClassForConstants(constants: readonly Constant[]): void {
    this.push(
      "public final class Constants {\n\n",
      "private Constants() {}\n\n",
    );
    for (const constant of constants) {
      this.writeConstant(constant);
    }
    this.push("}\n\n");
  }

  private writeConstant(constant: Constant): void {
    const { typeSpeller } = this;
    const javaType = typeSpeller.getJavaType(constant.type!, "frozen");
    const name = constant.name.text;

    const serializerExpression = typeSpeller.getSerializerExpression(
      constant.type!,
    );
    const jsonStringLiteral = JSON.stringify(
      JSON.stringify(constant.valueAsDenseJson),
    );
    this.push(
      `public static final ${javaType} ${name} = (\n`,
      `${serializerExpression}.fromJsonCode(${jsonStringLiteral})\n`,
      ");\n\n",
    );
  }

  private getDefaultExpression(type: ResolvedType): string {
    switch (type.kind) {
      case "primitive": {
        switch (type.primitive) {
          case "bool":
            return "false";
          case "int32":
          case "int64":
            return "0";
          case "uint64":
            return "kotlin.ULong.Companion.ZERO";
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
          case "float32":
          case "float64":
            return inputExpr;
          case "uint64":
            return nullability === "can-be-null"
              ? `java.util.Objects.requireNonNull(${inputExpr})`
              : inputExpr;
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

function getRecordId(struct: RecordLocation): string {
  const modulePath = struct.modulePath;
  const qualifiedRecordName = struct.recordAncestors
    .map((r) => r.name.text)
    .join(".");
  return `${modulePath}:${qualifiedRecordName}`;
}

export const GENERATOR = new JavaCodeGenerator();
