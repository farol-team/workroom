require "net/http"

module Rail
  # A capability answered by a system outside WorkRoom.
  #
  # `RAIL.md`: execution is server-side because the secret does not belong on
  # laptops. So the credential is read here, put in a header, and never travels in
  # anything an agent can see — not the descriptor `search` returns, and not the
  # result `execute` hands back.
  #
  # The far end speaks MCP, which is the seam capability crosses (Article P1); this
  # is one `tools/call` and the answer to it.
  class Bound
    DEFAULT_HTTP = lambda do |endpoint, rpc, credential|
      uri = URI.parse(endpoint)
      request = Net::HTTP::Post.new(uri)
      request["Content-Type"] = "application/json"
      request["Authorization"] = "Bearer #{credential}" if credential.present?
      request.body = rpc.to_json

      response = Net::HTTP.start(uri.hostname, uri.port, use_ssl: uri.scheme == "https") do |http|
        http.request(request)
      end
      { status: response.code.to_i, body: JSON.parse(response.body.presence || "{}") }
    end

    # Settable for the same reason `Memory::Store.current` is: a suite that must
    # not reach a system outside itself needs one place to say so, and a caller
    # deep in the registry should not have to be handed a transport to make that
    # possible.
    class << self
      attr_writer :http

      def http = @http || DEFAULT_HTTP
    end

    def initialize(capability:, http: nil)
      @capability = capability
      @http = http || self.class.http
    end

    # What `search_capabilities` shows. `kind: "action"` rather than knowledge or
    # skill, because an agent that cannot tell a thing it may do from a thing the
    # room believes will cite one as the other.
    #
    # Neither the endpoint nor the credential is in here. Where the answer comes
    # from is not the agent's business, and a listing is the easiest place for a
    # secret to end up somewhere it is logged.
    def descriptor
      { uri: @capability.uri, title: @capability.title,
        summary: @capability.summary.to_s, kind: "action" }
    end

    def call(args)
      answer = @http.call(@capability.endpoint, rpc(args), @capability.credential)
      return [ :error, failure(answer) ] unless answer[:status].to_i.between?(200, 299)

      [ :ok, text_of(answer[:body]) ]
    rescue StandardError => e
      # A system that is not ours being unreachable is an answer about that system,
      # not a fault in the turn. The agent is told which capability failed so it can
      # say so; the reason travels with it.
      [ :error, "#{@capability.key}: #{e.class} #{e.message}".strip ]
    end

    private

    def rpc(args)
      { jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: @capability.tool, arguments: args || {} } }
    end

    # MCP answers in content blocks. Everything the rail returns is text, the same
    # as reading an entry, so the blocks are joined rather than shaped into
    # something a caller would have to learn.
    def text_of(body)
      blocks = body.dig("result", "content")
      return body.to_json unless blocks.is_a?(Array)

      blocks.filter_map { |b| b["text"] }.join("\n")
    end

    def failure(answer)
      said = answer[:body].is_a?(Hash) ? (answer[:body]["error"] || answer[:body].to_json) : answer[:body].to_s
      "#{@capability.key}: #{said}"
    end
  end
end
