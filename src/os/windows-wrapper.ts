/**
 * Standard Windows command wrapper using .NET ProcessStartInfo to capture child PID.
 * Native binaries (like claude.exe) work best with this low-level wrapper.
 */
export function defaultWindowsPidWrapper(setupCmd: string, filePath: string, argList: string): string {
  const escapedArgs = argList.replace(/'/g, "''");
  return `${setupCmd}$_f_exe = if ("${filePath}" -notlike "*.*") { "${filePath}.exe" } else { "${filePath}" }; $_fleet_psi = [System.Diagnostics.ProcessStartInfo]::new($_f_exe, '${escapedArgs}'); $_fleet_psi.UseShellExecute = $false; $_fleet_psi.CreateNoWindow = $true; $_fleet_proc = [System.Diagnostics.Process]::Start($_fleet_psi); Write-Output "FLEET_PID:$($_fleet_proc.Id)"; [Console]::Out.Flush(); $_fleet_proc.WaitForExit(); exit $_fleet_proc.ExitCode`;
}
