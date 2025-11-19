import type { RecordKey, RecordLocation, ResolvedType } from "soiac";
import { ClassName, Namer } from "./naming.js";

export type TypeFlavor = "initializer" | "frozen" | "frozen-key";

/**
 * Transforms a type found in a `.soia` file into a Java type.
 */
export class TypeSpeller {
  constructor(
    readonly recordMap: ReadonlyMap<RecordKey, RecordLocation>,
    private readonly namer: Namer,
  ) {}

  getJavaType(
    type: ResolvedType,
    flavor: TypeFlavor,
    mustBeObject?: "must-be-object",
  ): string {
    switch (type.kind) {
      case "record": {
        const recordLocation = this.recordMap.get(type.key)!;
        const record = recordLocation.record;
        const className = this.namer.getClassName(recordLocation).qualifiedName;
        if (record.recordType === "struct") {
          return className;
        }
        // An enum.
        const _: "enum" = record.recordType;
        if (flavor === "initializer" || flavor === "frozen") {
          return className;
        } else if (flavor === "frozen-key") {
          return `${className}.Kind`;
        } else {
          const _: never = flavor;
          throw TypeError();
        }
      }
      case "array": {
        const itemType = this.getJavaType(type.item, flavor, "must-be-object");
        if (flavor === "initializer") {
          return `java.lang.Iterable<${itemType}>`;
        } else if (flavor === "frozen" || flavor === "frozen-key") {
          if (type.key) {
            const { keyType } = type.key;
            const javaKeyType = this.getJavaType(
              keyType,
              "frozen-key",
              "must-be-object",
            );
            return `land.soia.KeyedList<${itemType}, ${javaKeyType}>`;
          } else {
            return `java.util.List<${itemType}>`;
          }
        } else {
          const _: "kind" = flavor;
          throw TypeError();
        }
      }
      case "optional": {
        const otherType = this.getJavaType(
          type.other,
          flavor,
          "must-be-object",
        );
        return `java.util.Optional<${otherType}>`;
      }
      case "primitive": {
        const { primitive } = type;
        if (mustBeObject) {
          switch (primitive) {
            case "bool":
              return "java.lang.Boolean";
            case "int32":
              return "java.lang.Integer";
            case "int64":
            case "uint64":
              return "java.lang.Long";
            case "float32":
              return "java.lang.Float";
            case "float64":
              return "java.lang.Double";
            case "timestamp":
              return "java.time.Instant";
            case "string":
              return "java.lang.String";
            case "bytes":
              return "okio.ByteString";
            default: {
              const _: never = primitive;
              throw TypeError();
            }
          }
        } else {
          switch (primitive) {
            case "bool":
              return "boolean";
            case "int32":
              return "int";
            case "int64":
            case "uint64":
              return "long";
            case "float32":
              return "float";
            case "float64":
              return "double";
            case "timestamp":
              return "java.time.Instant";
            case "string":
              return "java.lang.String";
            case "bytes":
              return "okio.ByteString";
            default: {
              const _: never = primitive;
              throw TypeError();
            }
          }
        }
      }
    }
  }

  getClassName(recordKey: RecordKey): ClassName {
    const record = this.recordMap.get(recordKey)!;
    return this.namer.getClassName(record);
  }

  getSerializerExpression(type: ResolvedType): string {
    switch (type.kind) {
      case "primitive": {
        switch (type.primitive) {
          case "bool":
            return "land.soia.Serializers.bool()";
          case "int32":
            return "land.soia.Serializers.int32()";
          case "int64":
            return "land.soia.Serializers.int64()";
          case "uint64":
            return "land.soia.Serializers.uint64()";
          case "float32":
            return "land.soia.Serializers.float32()";
          case "float64":
            return "land.soia.Serializers.float64()";
          case "timestamp":
            return "land.soia.Serializers.timestamp()";
          case "string":
            return "land.soia.Serializers.string()";
          case "bytes":
            return "land.soia.Serializers.bytes()";
        }
        const _: never = type.primitive;
        throw TypeError();
      }
      case "array": {
        if (type.key) {
          const keyChain = type.key.path.map((f) => f.name.text).join(".");
          const path = type.key.path
            .map((f) => this.namer.structFieldToJavaName(f.name.text) + "()")
            .join(".");
          return (
            "land.soia.internal.ListSerializerKt.keyedListSerializer(\n" +
            this.getSerializerExpression(type.item) +
            `,\n"${keyChain}",\n(it) -> it.${path}\n)`
          );
        } else {
          return (
            "land.soia.Serializers.list(\n" +
            this.getSerializerExpression(type.item) +
            "\n)"
          );
        }
      }
      case "optional": {
        return (
          `land.soia.Serializers.javaOptional(\n` +
          this.getSerializerExpression(type.other) +
          `\n)`
        );
      }
      case "record": {
        return this.getClassName(type.key).qualifiedName + ".serializer()";
      }
    }
  }
}
