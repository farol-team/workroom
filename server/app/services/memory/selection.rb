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
    # Deliberately exact rather than truthy. "1", "yes" and "on" are what a
    # person types when they are guessing, and this variable exists precisely so
    # that PostgreSQL in production is stated rather than stumbled into.
    MEANT_IT = "true"

    def initialize(env = ENV)
      @env = env
    end

    def store
      store_class == OpenViking ? OpenViking.new(base_url: url, api_key: @env["OPENVIKING_API_KEY"]) : Local.new
    end

    def store_class
      return OpenViking if url.present?
      return Local unless production?
      # Precompiling assets loads the production environment inside the image,
      # where no store is configured and none can be. Rails marks that case, and
      # it is the difference between an image that cannot be built and a server
      # that will not start misconfigured.
      return Local if @env["SECRET_KEY_BASE_DUMMY"].present?
      return Local if @env["WORKROOM_MEMORY_IN_POSTGRES"] == MEANT_IT

      raise <<~MESSAGE
        No context store is configured, and this is production.

        What every room knows would be written to PostgreSQL, which works and
        retrieves by substring rather than by meaning — and nothing would say so.
        A server cannot tell a choice from an omission, so it refuses the
        omission.

        Set OPENVIKING_URL (and OPENVIKING_API_KEY), or say plainly that
        PostgreSQL is what you meant:

            WORKROOM_MEMORY_IN_POSTGRES=true
      MESSAGE
    end

    private

    def url = @env["OPENVIKING_URL"].presence
    def production? = @env["RAILS_ENV"] == "production"
  end
end
