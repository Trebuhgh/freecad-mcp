export function cadObjectStateInspectionPython(): string {
  return `
def cad_error_states_from_state_strings(states):
    return ["Invalid"] if "Invalid" in [str(state) for state in states] else []

def cad_object_error_states(obj):
    # DocumentObject.State also contains non-error lifecycle and UI flags such
    # as Touched, Recompute, Restore, Expanded, Partial, and Importing.  The
    # Invalid state is FreeCAD's public representation of ObjectStatus::Error.
    return cad_error_states_from_state_strings(obj.State)
`;
}
