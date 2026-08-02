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
