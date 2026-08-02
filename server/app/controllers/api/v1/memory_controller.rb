module Api
  module V1
    class MemoryController < BaseController
      before_action :require_channel_access!

      def index
        store = Memory::Store.current
        entries = params[:q].present? ? store.search(channel!, params[:q]) : store.all(channel!, limit: 50)
        # Whose agent recorded each entry is the expensive half of this payload,
        # and it is the same chain for every line — so the listing is asked for
        # once rather than followed per entry (#177).
        render json: Memory::Provenance.preload(entries.to_a).map { |e| serialize(e) }
      end

      # Direct write. Distillation proposes a Promotion instead; this path is
      # for a person deliberately recording something the room should know.
      def create
        entry = Memory::Store.current.write(
          channel!, title: params.require(:title), detail: params.require(:detail),
          overview: params[:overview], trust: params[:trust] || "human", author: current_user
        )
        Activity.log(actor: current_user, action: "memory.written", subject: entry)
        render json: serialize(entry), status: :created
      end

      private

      # A row id is the local table's, not the memory model's. An entry is
      # identified by its uri — which is what superseding and the rail both take,
      # and what an external store would hand back.
      def serialize(e)
        e.slice(:uri, :title, :abstract, :overview, :detail, :trust, :created_at)
         .merge(author: Memory::Provenance.of(e))
      end
    end
  end
end
