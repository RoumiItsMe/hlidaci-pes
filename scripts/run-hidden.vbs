' Spusti prikaz (node skript appky Trh bytu) bez viditelneho okna prikazove
' radky - pouziva naplanovana uloha, at na obrazovce neproblikava konzole
' pri kazdem behu (track.js jednou denne, process-telegram.js kazdych 5
' minut). Argument 1 = relativni cesta ke skriptu od korene repa, napr.
' "trh-bytu\process-telegram.js".
' Pouzita KRATKA (8.3) varianta cesty bez diakritiky - klasicky VBScript
' engine (cscript/wscript) muze cist .vbs soubor ve spatne kodove strance a
' "Hlidaci pes" s ceskymi znaky si pak poskladat spatne, takze CreateObject
' hlasi "System nemuze nalezt uvedeny soubor" i kdyz cesta realne existuje
' (overeno naostro, chyba 80070002). Kratka cesta je vzdy ciste ASCII.
Set objShell = CreateObject("WScript.Shell")
objShell.CurrentDirectory = "C:\Users\roman\DOCUME~1\HLDACP~1"
objShell.Run "node " & WScript.Arguments(0), 0, True
