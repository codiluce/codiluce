Option Strict On
Imports System
Namespace StructureVB
Public Class Service
 Private count As Integer
 Public Property Name As String = ""
 Public Sub New(seed As Integer)
  count = seed
 End Sub
 Public Function Read(value As Integer) As Integer
  Return value
 End Function
End Class
Public Module Helpers
 Public Function vbnetHelper(value As Integer) As Integer
  Return value
 End Function
End Module
End Namespace
