module Api
  module V1
    # The record read back. A digest names the same bytes in every room that
    # stored them, so the hash cannot be the permission: the artifact row inside
    # this channel is what authorizes, and a hash belonging to somewhere else
    # finds no row here (Article P5). That is also why the object store is never
    # asked whether it holds the bytes — its own journal envelopes live there
    # under the same kind of address, and answering from it would hand the
    # room's internal record to anybody who could name one.
    class RecordsController < BaseController
      before_action :require_channel_access!

      # One page of the listing. A mirror reads from `after`, the way
      # GitExport reads from its state file — only what is new since last time.
      LISTING_LIMIT = 500

      # The journal, listed (#220): rows in order, each carrying the payload
      # read back from its envelope in the object store — so a client can keep
      # a `.workroom/` mirror that is exactly as good as the journal, without
      # the server's database or a rake task. Read-only by design; there is no
      # write in this controller and never will be (spike #45).
      def index
        after = params[:after].to_i
        rows = channel!.channel_records.where(seq: (after + 1)..).order(:seq).limit(LISTING_LIMIT)
        render json: rows.map { |entry|
          entry.slice(:seq, :kind, :prev_hash, :entry_hash, :created_at)
               .merge(payload: JSON.parse(RecordStore::Objects.current.get(entry.entry_hash))["payload"])
        }
      end

      def show
        artifact = channel!.artifacts.find_by!(sha256: params[:sha256])

        send_data RecordStore::Objects.current.get(artifact.sha256),
                  filename: artifact.name,
                  type: artifact.content_type.presence || "application/octet-stream",
                  disposition: "attachment"
      end
    end
  end
end
