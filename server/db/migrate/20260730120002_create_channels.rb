class CreateChannels < ActiveRecord::Migration[8.1]
  def change
    create_table :channels do |t|
      t.string :slug,       null: false
      t.string :name,       null: false
      t.text   :purpose
      t.string :visibility, null: false, default: "open"  # open | private

      # Область памяти в OpenViking. Данные, а не соглашение:
      # переименование канала не ломает связь с памятью.
      t.string :memory_uri, null: false

      t.timestamps
    end
    add_index :channels, :slug, unique: true
  end
end
