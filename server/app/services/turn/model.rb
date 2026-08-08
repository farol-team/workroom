require "net/http"

module Turn
  # One call to a provider, and the answer to it.
  #
  # The first model call this server has ever made. Article P2 as amended (#304)
  # permits it under one condition, and the condition is upstream of this file: the
  # credential handed in belongs to exactly one person. Nothing here reads a
  # configuration, an environment variable, or a workspace setting for a key —
  # there is no path by which this class can obtain one that is not somebody's.
  #
  # The transport is settable, the way `Rail::Bound.http` and `Memory::Store.current`
  # already are. A suite must not reach a provider, and a caller deep in a job should
  # not have to be handed a transport to make that true.
  class Model
    ENDPOINT = "https://api.anthropic.com/v1/messages".freeze
    VERSION = "2023-06-01".freeze
    DEFAULT = "claude-sonnet-5".freeze
    MAX_TOKENS = 8_192

    DEFAULT_HTTP = lambda do |body, credential|
      uri = URI.parse(ENDPOINT)
      request = Net::HTTP::Post.new(uri)
      request["content-type"] = "application/json"
      request["anthropic-version"] = VERSION
      request["x-api-key"] = credential
      request.body = body.to_json

      response = Net::HTTP.start(uri.hostname, uri.port, use_ssl: true, read_timeout: 120) do |http|
        http.request(request)
      end
      { status: response.code.to_i, body: JSON.parse(response.body.presence || "{}") }
    end

    class << self
      attr_writer :http

      def http = @http || DEFAULT_HTTP
    end

    Answer = Struct.new(:text, :tool_calls, :stop_reason, :usage, keyword_init: true)

    def initialize(credential:, model: nil, http: nil)
      @credential = credential
      @model = model.presence || DEFAULT
      @http = http || self.class.http
    end

    # `messages` is the conversation so far in the provider's shape; `tools` is the
    # rail's two descriptors. Everything a turn can do is in that second argument,
    # which is the point of the rail: the surface stays at two however many
    # capabilities the channel has.
    def call(messages:, tools:, system:)
      answer = @http.call({ model: @model, max_tokens: MAX_TOKENS, system:, messages:,
                            tools: tools.map { |t| shape(t) } }, @credential)
      raise Refused, refusal(answer) unless answer[:status].to_i.between?(200, 299)

      blocks = Array(answer.dig(:body, "content"))
      Answer.new(
        text: blocks.select { |b| b["type"] == "text" }.filter_map { |b| b["text"] }.join("\n"),
        tool_calls: blocks.select { |b| b["type"] == "tool_use" }
                          .map { |b| { id: b["id"], name: b["name"], args: b["input"] || {} } },
        stop_reason: answer.dig(:body, "stop_reason"),
        usage: answer.dig(:body, "usage") || {}
      )
    end

    # A provider refusing is news about that provider, not a fault in the room. It
    # travels far enough to be said out loud and no further.
    class Refused < StandardError; end

    private

    def shape(tool)
      { name: tool[:name], description: tool[:description], input_schema: tool[:inputSchema] }
    end

    # Never the credential, and never the request body — a body carries the room's
    # messages, and a failure is not a reason to copy them into a log.
    def refusal(answer)
      said = answer[:body].is_a?(Hash) ? answer[:body].dig("error", "message") : nil
      "the model provider answered #{answer[:status]}#{": #{said}" if said}"
    end
  end
end
