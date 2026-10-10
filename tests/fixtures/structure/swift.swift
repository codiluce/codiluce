// Original Swift syntax only; no compiler, SDK or target execution.
import Foundation
public struct StructureSwift {
  public let value: Int
  public init(value: Int) { self.value = value }
  public func read(_ offset: Int) -> Int { value + offset }
  public subscript(at offset: Int) -> Int { value + offset }
}
extension StructureSwift {
  public func describe(prefix: String) -> String { prefix }
}
enum StructureSwiftState { case ready, failed(code: Int) }
