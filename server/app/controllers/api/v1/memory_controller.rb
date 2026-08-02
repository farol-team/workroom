module Api
  module V1
    class MemoryController < BaseController
      before_action :require_channel_access!

      def index
        store = Memory::Store.current
        entries = params[:q].present? ? store.search(channel!, params[:q]) : store.all(channel!, limit: 50)
        render json: entries.map { |e| serialize(e) }
      end

      # Direct write. Distillation proposes a Promotion instead; this path is
      # for a person deliberately recording something the room should know.
      def create
        title = params.require(:title)
        trust = params[:trust] || "human"
        entry = Memory::Store.current.write(
          channel!, title:, detail: params.require(:detail),
          overview: params[:overview], trust:, author: current_user
        )
        Activity.log(actor: current_user, action: "memory.written", subject: entry)

        # However memory was written — by an agent through the rail or by a
        # person here — the room's journal is one entry longer. A record that
        # only knows about the agent's writes describes half a room.
        RecordStore::Append.call(
          channel: channel!, kind: "memory", subject: nil,
          payload: { action: "written", uri: entry.uri, title:, trust:, author_id: current_user.id }
        )
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
