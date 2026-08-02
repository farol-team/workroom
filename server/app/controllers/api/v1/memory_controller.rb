module Api
  module V1
    class MemoryController < BaseController
      before_action :require_channel_access!

      def index
        store = Memory::Store.current
        entries = params[:q].present? ? store.search(channel!, params[:q]) : store.all(channel!, limit: 50)
        render json: entries.map { |e| serialize(e) }
      end

      # For a person deliberately recording something the room should know. An
      # agent writes through the rail instead, which stamps the run it came
      # from; here the author is whoever is holding the token.
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
        # The detail travels with it. A journal saying only that the room learned
        # something exports as a heading with nothing under it, and reading the
        # text back from the store later is not open to the mirror: by then the
        # entry may be superseded, and the store rightly answers with what the
        # room knows now rather than what it was told then.
        journaled = RecordStore::Append.call(
          channel: channel!, kind: "memory", subject: nil,
          payload: { action: "written", uri: entry.uri, title:, detail: entry.detail, trust:,
                     author_id: current_user.id }
        )
        # After the append, never before — the store keeps the journal lineage
        # beside the entry, so a reader of the entry finds the record of the
        # write (#213). The journal is the source of truth; the sidecar is only
        # its index.
        Memory::Store.current.annotate(entry.uri, action: "written", uri: entry.uri, title:,
                                       detail: entry.detail, trust:, author_id: current_user.id,
                                       seq: journaled.seq, entry_hash: journaled.entry_hash,
                                       recorded_at: journaled.created_at)
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
