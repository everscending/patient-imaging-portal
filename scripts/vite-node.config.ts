const config = {
  resolve: { conditions: ['react-server'] },
  ssr: { resolve: { conditions: ['react-server'], externalConditions: ['react-server'] } },
}

export default config
