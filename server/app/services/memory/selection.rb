module Memory
  # Which store holds what the rooms know, and why.
  #
  # This is a class rather than four lines in an initializer because the
  # interesting case is the one nobody sees: a production server deployed
  # without a context store used to start, work, and accumulate every room's
  # knowledge in PostgreSQL without a word. A decision that can fail silently in
  # production is a decision worth testing, and an initializer cannot be tested
  # without booting a second application.
  class Selection
    # A workspace holds its own store, because the boundary between rooms has to
    # be kept by whatever holds the data. PostgreSQL keeps its half through
    # row-level security; this is the other half, and an account in the context
    # store is what that store calls a workspace (docs/spikes/openviking-isolation.md).
    #
    # A workspace with none configured gets what the environment names — which
    # is every workspace until somebody provisions accounts, and is what keeps
    # the running server working.
    def initialize(env = ENV, workspace = nil)
      @env = env
      @workspace = workspace
    end

    def store
      store_class == OpenViking ? OpenViking.new(base_url: url, api_key: key) : Local.new
    end

    def store_class
      return OpenViking if url.present?
      return Local unless production?
      # Precompiling assets loads the production environment inside the image,
      # where no store is configured and none can be. Rails marks that case, and
      # it is the difference between an image that cannot be built and a server
      # that will not start misconfigured.
      return Local if @env["SECRET_KEY_BASE_DUMMY"].present?

      raise <<~MESSAGE
        No context store is configured, and this is production.

        What every room knows would be written to PostgreSQL, which works and
        retrieves by substring rather than by meaning.

        That fallback is why the suite runs against no external service and why
        bin/prototype runs with no credentials. It is not a way to run a
        workspace, and there is no variable that makes it one.

        Set OPENVIKING_URL and OPENVIKING_API_KEY.
      MESSAGE
    end

    private

    def url = @workspace&.openviking_url.presence || @env["OPENVIKING_URL"].presence
    def key = @workspace&.openviking_api_key.presence || @env["OPENVIKING_API_KEY"]
    def production? = @env["RAILS_ENV"] == "production"
  end
end
