require "net/http"

module Memory
  # The context store, as an agent is allowed to see it.
  #
  # The store isolates accounts, not channels (Article P5), so an agent holding the
  # account's own key reaches every channel in the workspace. This stands in front
  # of it: same MCP vocabulary, same tools, but a call that names something outside
  # the token's prefixes is refused here and the store never hears it.
  #
  # It lives under `services/memory` rather than in the controller because Article
  # S1 keeps store access on this side of the line; the controller reads a header
  # and renders what it gets back.
  class Gateway
    # Tools that answer about the person and touch nothing shared. Nothing to check
    # a prefix against, so nothing is checked.
    USER_SCOPED = %w[remember recall health].freeze

    # Tools that name something in the store. Every `viking://` they mention has to
    # be inside the token's prefixes — all of them, not the first one found.
    URI_TOOLS = %w[find search read list grep glob].freeze

    # Everything else — writes, moves, watches — is refused by omission rather than
    # by a denylist. A denylist is wrong the day the store grows a tool, and the way
    # it is wrong is that the new tool works.
    #
    # This is not a restriction on what an agent may remember: it writes its
    # channel's memory through the rail (Article P3), which stamps the run and the
    # author on the entry. A write that arrived here would carry neither, and an
    # entry nobody can trace is what Article P4 calls a defect.

    DEFAULT_FORWARD = lambda do |rpc, claims|
      room = Workspace.find_by(id: claims[:account])
      return { status: 502, body: { error: "no store for this workspace" } } if room&.openviking_url.blank?

      uri = URI.parse("#{room.openviking_url.chomp("/")}/mcp")
      request = Net::HTTP::Post.new(uri)
      request["Content-Type"] = "application/json"
      request["Authorization"] = "Bearer #{room.openviking_api_key}"
      # Identity is the server's to state. Whatever the caller put in the body about
      # who it is has already been ignored by the time we get here.
      request["X-OpenViking-Account"] = claims[:account].to_s
      request["X-OpenViking-User"] = claims[:user_id].to_s
      request.body = rpc.to_json

      response = Net::HTTP.start(uri.hostname, uri.port, use_ssl: uri.scheme == "https") do |http|
        http.request(request)
      end
      { status: response.code.to_i, body: JSON.parse(response.body.presence || "{}") }
    rescue JSON::ParserError, SystemCallError, Net::OpenTimeout, Net::ReadTimeout => e
      { status: 502, body: { error: "the context store did not answer: #{e.message}" } }
    end

    def initialize(token:, forward: DEFAULT_FORWARD)
      @claims = ScopeToken.verify(token)
      @forward = forward
    end

    def call(rpc)
      return unauthorized unless @claims
      return @forward.call(rpc, @claims) unless rpc["method"] == "tools/call"

      params = rpc["params"] || {}
      return refused(rpc, params["name"]) unless permitted?(params["name"], params["arguments"])

      @forward.call(rpc, @claims)
    end

    private

    def permitted?(name, arguments)
      return true if USER_SCOPED.include?(name)
      return false unless URI_TOOLS.include?(name)

      addressed(arguments).all? { |uri| in_scope?(uri) }
    end

    # Any argument naming a store URI, whatever the tool decided to call that
    # argument. Keying on `uri` alone missed `target_uri`, and the next tool will
    # have its own word for it.
    def addressed(arguments)
      (arguments || {}).values.grep(String).select { |v| v.start_with?(ScopeToken::URI_SCHEME) }
    end

    # Prefixes carry their trailing slash, which is what keeps `.../sales/` from
    # admitting `.../sales-archive/`.
    def in_scope?(uri) = @claims[:prefixes].any? { |prefix| uri.start_with?(prefix) }

    def unauthorized
      { status: 401, body: { error: "this token does not name a scope" } }
    end

    # An error the agent can read and work around — it can say it has no access to
    # that room. A transport failure would end the turn instead, which is a worse
    # answer to a question that has one.
    def refused(rpc, name)
      { status: 200,
        body: { jsonrpc: "2.0", id: rpc["id"],
                result: { isError: true,
                          content: [ { type: "text",
                                       text: "#{name}: outside this channel's memory" } ] } } }
    end
  end
end
