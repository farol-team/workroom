module Api
  module V1
    # The context store as an agent reaches it: same MCP, one channel wide.
    #
    # Authenticated by a scope token rather than by a membership, because the caller
    # is an agent holding what the server minted for one channel, not a person
    # holding what identifies them everywhere. `authenticate!` is skipped for that
    # reason and replaced, never simply dropped.
    class MemoryGatewayController < BaseController
      skip_before_action :authenticate!
      before_action :enter_scope!

      def call
        result = Memory::Gateway.new(token: bearer).call(rpc_body)
        render json: result[:body], status: result[:status]
      end

      private

      def bearer = request.headers["Authorization"].to_s.delete_prefix("Bearer ").presence

      def rpc_body = JSON.parse(request.raw_post.presence || "{}")

      # The boundary every query in this transaction sees, set from the token and
      # from nothing the caller said about itself. Refusing here rather than inside
      # the gateway keeps an unverifiable token from reaching a database lookup at
      # all.
      def enter_scope!
        claims = Memory::ScopeToken.verify(bearer)
        return render_error("unauthorized", :unauthorized) unless claims

        @current_workspace = Workspace.find_by(id: claims[:account])
        return render_error("unauthorized", :unauthorized) unless @current_workspace

        @current_user = User.find_by(id: claims[:user_id])
        enter_workspace
      end

      rescue_from JSON::ParserError do
        render_error("a request body that is not JSON-RPC", :bad_request)
      end
    end
  end
end
