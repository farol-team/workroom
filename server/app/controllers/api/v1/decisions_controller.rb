module Api
  module V1
    # Where a person answers a proposal.
    #
    # The agent proposed; nothing outside this room has happened yet. This is the only
    # place the far end is reached for a capability that changes something, and it is
    # reached after somebody said yes and never before — so "who decided" is not a
    # field somebody has to remember to fill in, it is the thing that made the call.
    class DecisionsController < BaseController
      before_action :require_channel_access!
      before_action :require_membership!, only: :answer

      ANSWERS = %w[approve reject discuss].freeze

      def index
        render json: channel!.decisions.pending.order(:id).map(&:describe)
      end

      def answer
        decision = channel!.decisions.find(params[:id])
        verb = params[:answer].to_s
        return render_error("answer must be one of #{ANSWERS.join(', ')}", :bad_request) unless ANSWERS.include?(verb)

        settled = send(:"#{verb}!", decision)
        # Not an error the client did anything about: somebody else got there first.
        # Conflict rather than forbidden, because the request was allowed and the
        # world had simply moved.
        return render_error("this was already answered", :conflict) unless settled

        Broadcast.decision(decision)
        render json: decision.describe
      end

      private

      # Approving is the call. Everything the far end needs was chosen when the
      # proposal was made — a person answers the thing they were shown, and an
      # argument that arrived with the answer would be one nobody read.
      def approve!(decision)
        return false unless decision.approve!(by: current_user)

        status, said = Rail::Bound.new(capability: decision.bound_capability).call(decision.arguments)
        # The answer is kept whether the far end worked or not. A call that failed is
        # news about that system; a decision that vanished because of it is a person's
        # yes that the room has no record of.
        decision.update!(result: said.to_s)
        Activity.log(actor: current_user, action: "decision.#{status == :ok ? 'done' : 'failed'}",
                     subject: decision)
        true
      end

      def reject!(decision)
        return false unless decision.reject!(by: current_user, reason: params[:reason])

        Activity.log(actor: current_user, action: "decision.rejected", subject: decision)
        true
      end

      def discuss!(decision) = decision.discuss!(by: current_user, reason: params[:reason])

      def require_membership!
        return if current_user.member_of?(channel!)

        render_error("only somebody in this room decides what leaves it", :forbidden)
      end
    end
  end
end
