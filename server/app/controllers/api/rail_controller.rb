module Api
  # The capability rail: one MCP endpoint per channel, two tools.
  #
  # The channel lives in the url and there is one agent session per channel, so
  # a rail url cannot address the wrong room — scope is structural rather than
  # a parameter somebody must remember to check.
  class RailController < BaseController
    PROTOCOL_VERSION = "2025-06-18".freeze

    before_action :require_channel_access!

    def call
      id = params[:id]
      result =
        case params[:method]
        when "initialize"  then initialize_result
        when "tools/list"  then { tools: registry.descriptors }
        when "tools/call"  then tool_call
        when %r{\Anotifications/} then return head(:accepted)
        else return render(json: rpc_error(id, -32_601, "unknown method"))
        end

      render json: { jsonrpc: "2.0", id: id, result: result }
    end

    private

    def registry = @registry ||= Rail::Registry.new(channel: @channel, user: current_user)

    def initialize_result
      { protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "workroom-rail", version: "1" } }
    end

    def tool_call
      args = params.dig(:params, :arguments) || {}
      case params.dig(:params, :name)
      when "search_capabilities"
        text(registry.search(args[:query]).to_json)
      when "execute_capability"
        status, body = registry.execute(args[:uri], args[:args]&.to_unsafe_h)
        text(body, error: status == :error)
      else
        text("unknown tool", error: true)
      end
    end

    def text(body, error: false)
      { content: [ { type: "text", text: body.to_s } ], isError: error }.compact_blank
    end

    def rpc_error(id, code, message) = { jsonrpc: "2.0", id: id, error: { code: code, message: message } }

    # A filter, so a refusal halts rather than relying on the action to return.
    def require_channel_access!
      channel!
      authorize_channel!
    end
  end
end
