module Api
  # Review of what the room is asked to remember. Approval is a human act by
  # construction — there is no code path that applies a promotion without one.
  class PromotionsController < BaseController
    before_action :load_promotion, only: %i[approve reject]

    def index
      channel!
      authorize_channel!
      return if performed?

      render json: channel!.promotions.pending.order(:created_at).map { |p| serialize(p) }
    end

    def approve
      @promotion.approve!(current_user)
      render json: serialize(@promotion.reload)
    end

    def reject
      @promotion.reject!(current_user)
      render json: serialize(@promotion.reload)
    end

    private

    # A filter so a refusal stops the action, rather than a helper that renders
    # and lets it carry on into a second render.
    def load_promotion
      @promotion = Promotion.find(params[:id])
      @channel = @promotion.channel
      authorize_channel!
    end

    def serialize(p)
      p.slice(:id, :state, :rationale, :viking_uri, :created_at)
       .merge(channel: p.channel.slug, source_type: p.source_type, source_id: p.source_id)
    end
  end
end
