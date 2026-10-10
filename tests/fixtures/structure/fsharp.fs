namespace StructureFSharp
module Services =
 type Pair = {Name:string; Count:int}
 type State = | Ready | Failed of code:int
 type Service(seed:int) =
  member _.Read(x:int):int=x+seed
  member val Name = "" with get,set
  new() = Service(0)
 let inline fsharpHelper x=x
 let callback=fun x->x
