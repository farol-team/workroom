module Api
  module V1
    class MessagesController < BaseController
      before_action :require_channel_access!

      def create
        message = nil

        # The journal entry is part of writing the message, not a report about
        # it: half a record is a room whose history has a hole in it that
        # nothing marks. The request already runs in one transaction, but the
        # pairing is stated where it is made rather than resting on a filter in
        # the base class.
        ActiveRecord::Base.transaction do
          message = channel!.messages.create!(
            author: current_user, body: params.require(:body), parent_id: params[:parent_id]
          )
          RecordStore::Append.call(channel: channel!, kind: "message.created", subject: message,
                                   payload: MessageSerializer.call(message).as_json)
        end

        # Outside the transaction, and unchanged: the room hears about the
        # message the same way it always has, and hears about it only once the
        # write it describes is real.
        Broadcast.message(message)
        render json: MessageSerializer.call(message), status: :created
      end
    end
  end
end
