module Api
  module V1
    # Where this person's turns run, and what pays for them.
    #
    # Everything here is `current_user`'s. There is no parameter naming a person and
    # no admin path, deliberately: Article P2 permits a server-held credential only
    # because it belongs to exactly one person, and a key somebody else could set is
    # not that person's. The condition is kept by there being no way to break it
    # rather than by a check somebody could forget.
    class ExecutionController < BaseController
      MODES = %w[own hosted].freeze
      PROVIDER = "anthropic".freeze

      def show
        render json: state
      end

      def update
        mode = params[:mode].presence || current_user.execution_mode
        return render_error("mode must be one of #{MODES.join(', ')}", :bad_request) unless MODES.include?(mode)

        current_user.update!(execution_mode: mode)
        remember_key if params[:secret].present?
        # Back on your own machine is the server having no reason to hold it. A key
        # left behind after the reason for it went away is the kind nobody notices
        # until it appears somewhere.
        UserCredential.where(user: current_user).delete_all if mode == "own"

        Activity.log(actor: current_user, action: "execution.#{mode}", subject: current_user)
        render json: state
      end

      private

      def remember_key
        provider = params[:provider].presence || PROVIDER
        UserCredential.remember(user: current_user, provider:, secret: params[:secret])
      end

      # That there is a key, and from when. Never the key: an endpoint that reads one
      # back turns every other bug in this application into a key disclosure.
      def state
        { mode: current_user.execution_mode,
          credential: UserCredential.find_by(user: current_user)&.describe }
      end
    end
  end
end
