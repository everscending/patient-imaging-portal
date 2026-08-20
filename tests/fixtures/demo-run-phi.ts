// PHI rows created only by the auxiliary database fixtures in demo-run.sh.
// Producers and the artifact scanner share these values so neither can drift.
export const DEMO_RPC_PATIENT = {
  date_of_birth: '1990-01-01',
  full_name: 'RPC Patient',
  email: 'rpc.patient@example.test',
  phone: null,
}

export const DEMO_RPC_PROVIDER = { full_name: 'Dr. RPC' }
export const DEMO_E8_PROVIDER = { full_name: 'E8 Provider' }

export const DEMO_AUXILIARY_PHI_ROWS = {
  patients: [DEMO_RPC_PATIENT],
  providers: [DEMO_RPC_PROVIDER, DEMO_E8_PROVIDER],
  reports: [],
  studies: [],
}
